import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql, workerSql } from "../db.js";
import { dropMigrationLeftovers } from "../engine/demo.js";
import { contractMerge, revertMerge } from "../engine/contract.js";
import { compilePlan } from "../engine/plan.js";
import { persistPlan, runMerge } from "../engine/runner.js";
import { assertBranchesAllowRewind, regenerateFeatureBranches } from "../engine/rewind.js";
import { applySchemaOps } from "../ir/parse.js";
import { subscribeMerge, emitMergeEvent } from "../telemetry.js";
import { isDirty, requireBranch } from "../vcs/branches.js";
import { requireCommit } from "../vcs/commits.js";
import { merge } from "../vcs/merge.js";

const MERGE_LOCK = 0x6769746462;
const mergeBody = z.object({ source: z.string(), target: z.string() });

function mergeId(request: { params: unknown }): number {
  return z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
}

async function activeMerge(): Promise<number | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text FROM gitdb.merges
     WHERE state = 'running' ORDER BY created_at LIMIT 1`;
  return row ? Number(row.id) : null;
}

async function waitForActiveMerge(): Promise<number | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = await activeMerge();
    if (id != null) return id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

function conflict(state: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(state), { statusCode: 409, payload: { state, ...extra } });
}

/** Rewind drops expand backups; those merges can no longer be reverted. */
async function closeMergesForDroppedBackups(): Promise<void> {
  await sql`
    UPDATE gitdb.merges
       SET state = 'reverted',
           finished_at = coalesce(finished_at, now()),
           error = 'expand backup dropped by rewind'
     WHERE state = 'merged'
       AND contracted_at IS NULL
       AND source_branch <> 'rewind'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(plan) AS step
          WHERE coalesce(step->>'backup', '') <> ''
            AND NOT EXISTS (
              SELECT 1
                FROM pg_attribute a
                JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'main'
                 AND c.relkind = 'r'
                 AND c.relname = step->>'table'
                 AND a.attname = step->>'backup'
                 AND a.attnum > 0
                 AND NOT a.attisdropped
            )
       )`;
}

export async function getMerge(id: number): Promise<Record<string, unknown>> {
  const [merge] = await sql<Record<string, unknown>[]>`
    SELECT id::text, source_branch, source_commit, target_commit, base_commit,
           result_ir, plan, state, error, started_at, finished_at, contracted_at, created_at
      FROM gitdb.merges WHERE id = ${id}`;
  if (!merge) throw Object.assign(new Error(`no such merge: ${id}`), { statusCode: 404 });
  const steps = await sql`
    SELECT seq, kind, sql, state, rows_done, rows_total, cursor, lock_attempts, ms, error
      FROM gitdb.merge_steps WHERE merge_id = ${id} ORDER BY seq`;
  return { ...merge, id, steps };
}

/** Claim the merge advisory lock, run persisted steps, and regenerate branches after a rewind. */
export async function applyMergeJob(id: number): Promise<Record<string, unknown>> {
  const [job] = await sql<{ source_branch: string }[]>`
    SELECT source_branch FROM gitdb.merges WHERE id = ${id}`;
  if (!job) throw Object.assign(new Error(`no such merge: ${id}`), { statusCode: 404 });
  if (job.source_branch === "rewind") await assertBranchesAllowRewind(sql);

  const claimed = await sql.begin(async (tx) => {
    const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${MERGE_LOCK}) AS locked`;
    if (!lock?.locked) return false;
    const running = await activeMerge();
    if (running != null && running !== id) throw conflict("merge_in_progress", { mergeId: running });
    const rows = await tx`
      UPDATE gitdb.merges SET state = 'running', started_at = coalesce(started_at, now()), error = NULL
       WHERE id = ${id} AND state IN ('planned', 'failed')
       RETURNING id`;
    if (!rows.length) {
      const [existing] = await tx<{ state: string }[]>`SELECT state FROM gitdb.merges WHERE id = ${id}`;
      if (!existing) throw Object.assign(new Error(`no such merge: ${id}`), { statusCode: 404 });
      throw conflict(existing.state);
    }
    return true;
  });
  if (!claimed) {
    const running = await waitForActiveMerge();
    throw conflict("merge_in_progress", { mergeId: running });
  }

  await workerSql`SELECT pg_advisory_lock(${MERGE_LOCK})`;
  try {
    await emitMergeEvent(sql, id, { type: "merge_started", mergeId: id });
    await runMerge(id, {
      sql,
      worker: workerSql,
      emit: (event) => { void emitMergeEvent(sql, id, event as unknown as Record<string, unknown>); },
    });
    if (job.source_branch === "rewind") {
      await dropMigrationLeftovers(sql);
      await closeMergesForDroppedBackups();
      await regenerateFeatureBranches(sql);
    }
    await emitMergeEvent(sql, id, { type: "merge_finished", mergeId: id });
  } finally {
    await workerSql`SELECT pg_advisory_unlock(${MERGE_LOCK})`;
  }
  return getMerge(id);
}

export async function mergeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/merges", async (request, reply) => {
    const body = mergeBody.parse(request.body);
    if (body.target !== "main") {
      throw Object.assign(new Error("merges must target main"), { statusCode: 400, code: "invalid_target" });
    }
    if (body.source === "main") {
      throw Object.assign(new Error("merge source must be a branch"), { statusCode: 400, code: "invalid_source" });
    }
    const source = await requireBranch(sql, body.source);
    const target = await requireBranch(sql, "main");
    if (await isDirty(sql, body.source)) throw conflict("dirty");
    if (!source.head_commit || !source.base_commit || !target.head_commit) throw new Error("branch commit metadata is incomplete");

    const [base, ours, theirs] = await Promise.all([
      requireCommit(sql, source.base_commit),
      requireCommit(sql, target.head_commit),
      requireCommit(sql, source.head_commit),
    ]);
    const result = merge(base.ir, ours.ir, theirs.ir);
    if (result.conflicts) return reply.code(409).send({ state: "conflict", conflicts: result.conflicts });
    const resultIR = applySchemaOps(ours.ir, result.ops);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
      ) VALUES (
        ${body.source}, ${source.head_commit}, ${target.head_commit}, ${source.base_commit},
        ${sql.json(resultIR as never)}, '[]'::jsonb, 'planned'
      ) RETURNING id::text`;
    const id = Number(row!.id);
    const plan = compilePlan(result.ops, { mergeId: id, from: ours.ir });
    await persistPlan(sql, id, plan);
    return reply.code(201).send({ id, state: "planned", ops: result.ops, plan, resultIR });
  });

  app.post("/api/merges/:id/apply", async (request) => applyMergeJob(mergeId(request)));

  app.post("/api/merges/:id/revert", async (request) => {
    const id = mergeId(request);
    await revertMerge(id, { sql, emit: (event) => { void emitMergeEvent(sql, id, event as unknown as Record<string, unknown>); } });
    await emitMergeEvent(sql, id, { type: "merge_reverted", mergeId: id });
    return getMerge(id);
  });

  app.post("/api/merges/:id/contract", async (request) => {
    const id = mergeId(request);
    await contractMerge(id, { sql, emit: (event) => { void emitMergeEvent(sql, id, event as unknown as Record<string, unknown>); } });
    await emitMergeEvent(sql, id, { type: "merge_contracted", mergeId: id });
    return getMerge(id);
  });

  app.get("/api/merges/:id", async (request) => getMerge(mergeId(request)));

  app.get("/api/merges/:id/events", { websocket: true }, async (socket, request) => {
    const id = mergeId(request);
    const events = await sql<{ id: string; ts: Date; payload: unknown }[]>`
      SELECT id::text, ts, payload FROM gitdb.events WHERE merge_id = ${id} ORDER BY id`;
    for (const event of events) socket.send(JSON.stringify(event));
    const unsubscribe = subscribeMerge(id, (event) => socket.send(JSON.stringify(event)));
    socket.on("close", unsubscribe);
  });
}
