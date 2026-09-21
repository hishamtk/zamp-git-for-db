import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { diff } from "../diff/diff.js";
import { leftoverShadowColumns } from "../engine/demo.js";
import type { MigrationStep } from "../engine/plan.js";
import { insertPlannedMerge, persistPlan } from "../engine/runner.js";
import { assertBranchesAllowRewind } from "../engine/rewind.js";
import { MAIN_SCHEMA, qid, qname } from "../ident.js";
import { requireBranch } from "../vcs/branches.js";
import { requireCommit, resolveRewindTarget } from "../vcs/commits.js";
import { applyMergeJob, getMerge } from "./merges.js";

const rewindBody = z.object({
  commit: z.string().min(1).optional(),
  mergesBack: z.number().int().positive().optional(),
}).refine((body) => Boolean(body.commit) !== Boolean(body.mergesBack), {
  message: "provide exactly one of commit or mergesBack",
});

function rewindId(request: { params: unknown }): number {
  return z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
}

export async function rewindRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/rewinds", async (request, reply) => {
    const body = rewindBody.parse(request.body);
    const main = await requireBranch(sql, "main");
    if (!main.head_commit) throw new Error("main has no commits");
    await assertBranchesAllowRewind(sql);

    const { target, undone } = await resolveRewindTarget(sql, main.head_commit, body);
    // Diff committed HEAD against the ancestor — not the live catalog.
    // Leftover expand columns or an unrestored retype on another table must not
    // leak into a rewind that only undoes these commits.
    const head = await requireCommit(sql, main.head_commit);
    const ops = diff(head.ir, target.ir);
    const { id, plan } = await insertPlannedMerge(sql, {
      sourceBranch: "rewind",
      sourceCommit: target.id,
      targetCommit: main.head_commit,
      baseCommit: target.id,
      resultIR: target.ir,
      fromIR: head.ir,
      ops,
    });
    // Committed IRs omit expand backups. Drop those leftovers as real DDL —
    // compilePlan would mark drop_column as manual contract and skip it.
    const shadows = await leftoverShadowColumns(sql, target.ir);
    const extra: MigrationStep[] = shadows.map((col, index) => ({
      seq: plan.length + index,
      kind: "ddl",
      sql: `ALTER TABLE ${qname(MAIN_SCHEMA, col.table)} DROP COLUMN IF EXISTS ${qid(col.column)}`,
      risk: "SAFE",
      table: col.table,
      column: col.column,
    }));
    const nextPlan = extra.length ? [...plan, ...extra] : plan;
    if (extra.length) await persistPlan(sql, id, nextPlan);
    return reply.code(201).send({
      id,
      state: "planned",
      ops,
      plan: nextPlan,
      resultIR: target.ir,
      targetCommit: target.id,
      undone: undone.map((commit) => ({
        id: commit.id,
        message: commit.message,
        created_at: commit.created_at,
      })),
    });
  });

  app.post("/api/rewinds/:id/apply", async (request) => applyMergeJob(rewindId(request)));
  app.get("/api/rewinds/:id", async (request) => getMerge(rewindId(request)));
}
