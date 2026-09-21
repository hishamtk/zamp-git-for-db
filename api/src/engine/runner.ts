import { sql as requestSql, workerSql, type Sql } from "../db.js";
import type { SchemaOp } from "../diff/diff.js";
import { hashIR } from "../ir/canonical.js";
import { SchemaIRSchema, type SchemaIR } from "../ir/types.js";
import { runBackfill, type BackfillProgress } from "./backfill.js";
import { guardedDDLWithViews } from "./deps.js";
import { guardedDDL, type EmitEvent } from "./guarded.js";
import { createIndexConcurrently, type IndexAttemptEvent } from "./indexes.js";
import { compilePlan, type MigrationStep } from "./plan.js";

export type RunnerEvent = EmitEvent | BackfillProgress | IndexAttemptEvent;

type MergeRow = {
  id: string;
  source_branch: string;
  source_commit: string;
  target_commit: string;
  plan: unknown;
  result_ir: unknown | null;
};

type StepRow = {
  seq: number;
  state: "pending" | "running" | "done" | "failed" | "skipped";
};

/** Insert a planned merge and persist its compiled steps. */
export async function insertPlannedMerge(
  sql: Sql,
  opts: {
    sourceBranch: string;
    sourceCommit: string;
    targetCommit: string;
    baseCommit: string;
    resultIR: SchemaIR;
    fromIR: SchemaIR;
    ops: SchemaOp[];
  },
): Promise<{ id: number; plan: MigrationStep[] }> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO gitdb.merges (
      source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
    ) VALUES (
      ${opts.sourceBranch}, ${opts.sourceCommit}, ${opts.targetCommit}, ${opts.baseCommit},
      ${sql.json(opts.resultIR as never)}, '[]'::jsonb, 'planned'
    ) RETURNING id::text`;
  const id = Number(row!.id);
  const plan = compilePlan(opts.ops, { mergeId: id, from: opts.fromIR });
  await persistPlan(sql, id, plan);
  return { id, plan };
}

/** Persist a compiled plan without resetting progress from an earlier run. */
export async function persistPlan(sql: Sql, mergeId: number, plan: MigrationStep[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE gitdb.merges
         SET plan = ${tx.json(plan as never)}
       WHERE id = ${mergeId}`;
    for (const step of plan) {
      await tx`
        INSERT INTO gitdb.merge_steps (merge_id, seq, kind, sql, state)
        VALUES (${mergeId}, ${step.seq}, ${step.kind}, ${step.sql}, 'pending')
        ON CONFLICT (merge_id, seq) DO UPDATE
          SET kind = EXCLUDED.kind, sql = EXCLUDED.sql
        WHERE gitdb.merge_steps.state = 'pending'`;
    }
  });
}

function swapsViews(step: MigrationStep): boolean {
  return (
    step.kind === "cutover" ||
    /\b(?:DROP\s+COLUMN|RENAME\s+COLUMN|ALTER\s+COLUMN\b[\s\S]*\bTYPE)\b/i.test(step.sql)
  );
}

async function finishMerge(sql: Sql, merge: MergeRow): Promise<void> {
  await sql.begin(async (tx) => {
    if (merge.result_ir) {
      const result = SchemaIRSchema.parse(merge.result_ir);
      const id = hashIR(result);
      await tx`
        INSERT INTO gitdb.commits (id, parent_id, branch, message, ir)
        VALUES (
          ${id}, ${merge.target_commit}, 'main',
          ${`merge ${merge.source_branch}`},
          ${tx.json(result as never)}
        )
        ON CONFLICT (id) DO NOTHING`;
      await tx`
        UPDATE gitdb.branches
           SET head_commit = ${id}
         WHERE name = 'main'`;
    }
    await tx`
      UPDATE gitdb.merges
         SET state = 'merged', contracted_at = NULL, finished_at = now(), error = NULL
       WHERE id = ${merge.id}`;
  });
}

/**
 * Execute persisted steps in sequence. Done/skipped rows are never replayed;
 * a process killed during a step resumes that first non-done step.
 */
export async function runMerge(
  mergeId: number,
  options: {
    sql?: Sql;
    worker?: Sql;
    plan?: MigrationStep[];
    emit?: (event: RunnerEvent) => void;
  } = {},
): Promise<void> {
  const sql = options.sql ?? requestSql;
  const worker = options.worker ?? workerSql;
  if (options.plan) await persistPlan(sql, mergeId, options.plan);

  const [merge] = await sql<MergeRow[]>`
    SELECT id::text, source_branch, source_commit, target_commit, plan, result_ir
      FROM gitdb.merges
     WHERE id = ${mergeId}`;
  if (!merge) throw new Error(`no such merge: ${mergeId}`);
  const plan = (options.plan ?? merge.plan) as MigrationStep[];
  if (!Array.isArray(plan)) throw new Error(`merge ${mergeId} has no compiled plan`);

  const rows = await sql<StepRow[]>`
    SELECT seq, state
      FROM gitdb.merge_steps
     WHERE merge_id = ${mergeId}
     ORDER BY seq`;
  const states = new Map(rows.map((row) => [row.seq, row.state]));
  if (rows.length !== plan.length) {
    await persistPlan(sql, mergeId, plan);
    for (const step of plan) if (!states.has(step.seq)) states.set(step.seq, "pending");
  }

  await sql`
    UPDATE gitdb.merges
       SET state = 'running', started_at = coalesce(started_at, now()), error = NULL
     WHERE id = ${mergeId}`;

  for (const step of [...plan].sort((a, b) => a.seq - b.seq)) {
    const state = states.get(step.seq);
    if (state === "done" || state === "skipped") continue;
    if (step.manual || step.kind === "contract") {
      await sql`
        UPDATE gitdb.merge_steps
           SET state = 'skipped', error = NULL
         WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
      continue;
    }

    const started = performance.now();
    let lockAttempts = 0;
    const emit = (event: RunnerEvent) => {
      if (event.type === "lock_retry") lockAttempts += 1;
      options.emit?.(event);
    };
    await sql`
      UPDATE gitdb.merge_steps
         SET state = 'running', error = NULL
       WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;

    try {
      if (step.kind === "backfill") {
        await runBackfill(mergeId, step, { sql: worker, emit });
      } else if (step.kind === "index_concurrent") {
        await createIndexConcurrently(step.sql, { sql: worker, emit });
      } else if (step.table && swapsViews(step)) {
        await guardedDDLWithViews(sql, { ddl: step.sql, table: step.table, emit });
      } else {
        await guardedDDL(sql, step.sql, emit);
      }
      await sql`
        UPDATE gitdb.merge_steps
           SET state = 'done',
               lock_attempts = lock_attempts + ${lockAttempts},
               ms = ${Math.round(performance.now() - started)},
               error = NULL
         WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE gitdb.merge_steps
             SET state = 'failed',
                 lock_attempts = lock_attempts + ${lockAttempts},
                 ms = ${Math.round(performance.now() - started)},
                 error = ${message}
           WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
        await tx`
          UPDATE gitdb.merges
             SET state = 'failed', error = ${message}
           WHERE id = ${mergeId}`;
      });
      throw error;
    }
  }

  await finishMerge(sql, merge);
}
