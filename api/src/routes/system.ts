import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql, workerSql } from "../db.js";
import { diff } from "../diff/diff.js";
import { contractMerge } from "../engine/contract.js";
import { compilePlan } from "../engine/plan.js";
import { persistPlan, runMerge } from "../engine/runner.js";
import { validateBranch } from "../engine/validate.js";
import { assertBranchName } from "../ident.js";
import { mainIR, listBranches, deleteBranch, requireBranch } from "../vcs/branches.js";
import { requireCommit, resolveDemoSeedCommit, SEED_TABLES } from "../vcs/commits.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => {
    await sql`SELECT 1`;
    return { status: "ok" };
  });

  app.post("/api/validate", async (request) => {
    const { branch } = z.object({ branch: z.string() }).parse(request.body);
    assertBranchName(branch);
    await requireBranch(sql, branch);
    return validateBranch(sql, branch);
  });

  app.post("/api/demo/reset", async () => {
    for (const branch of await listBranches(sql)) {
      if (branch.name !== "main") await deleteBranch(sql, branch.name);
    }
    const main = await requireBranch(sql, "main");
    // Restore the seeded snapshot, not the oldest root commit and not whatever
    // last reset wrote into base_commit. Seeded tables added after commit 0
    // would otherwise be compiled as DROP TABLE.
    const seedId = await resolveDemoSeedCommit(sql);
    const target = await requireCommit(sql, seedId);
    const current = await mainIR(sql);
    const ops = diff(current, target.ir);
    const droppingSeed = ops.some(
      (op) => op.kind === "drop_table" && (SEED_TABLES as readonly string[]).includes(op.table),
    );
    if (droppingSeed) {
      throw Object.assign(new Error("demo reset refused to drop a seeded table"), {
        statusCode: 500,
        code: "seed_commit_stale",
      });
    }
    if (!ops.length) {
      await sql`UPDATE gitdb.branches SET head_commit = ${seedId} WHERE name = 'main'`;
      return { state: "reset", commit: seedId };
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
      ) VALUES (
        'demo-reset', ${main.head_commit}, ${main.head_commit}, ${main.base_commit},
        ${sql.json(target.ir as never)}, '[]'::jsonb, 'planned'
      ) RETURNING id::text`;
    const id = Number(row!.id);
    const plan = compilePlan(ops, { mergeId: id, from: current });
    await persistPlan(sql, id, plan);
    await runMerge(id, { sql, worker: workerSql, plan });
    if (plan.some((step) => step.manual || step.kind === "contract")) {
      await contractMerge(id, { sql });
    }
    await sql`UPDATE gitdb.branches SET head_commit = ${seedId}, base_commit = ${seedId} WHERE name = 'main'`;
    return { state: "reset", commit: seedId, mergeId: id };
  });
}
