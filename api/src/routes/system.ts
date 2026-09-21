import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { dropMigrationLeftovers, pruneDemoHistory, sweepMainToIR } from "../engine/demo.js";
import { validateBranch } from "../engine/validate.js";
import { assertBranchName } from "../ident.js";
import { listBranches, deleteBranch, requireBranch } from "../vcs/branches.js";
import { requireCommit, resolveDemoSeedCommit } from "../vcs/commits.js";

async function deleteFeatureBranches(): Promise<void> {
  for (const branch of await listBranches(sql)) {
    if (branch.name === "main") continue;
    try {
      await deleteBranch(sql, branch.name);
    } catch (error) {
      if ((error as { code?: string }).code !== "no_such_branch") throw error;
    }
  }
}

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
    await sql`
      UPDATE gitdb.merges
         SET state = 'failed', error = 'interrupted by demo reset'
       WHERE state = 'running'`;
    await deleteFeatureBranches();
    const seedId = await resolveDemoSeedCommit(sql);
    const target = await requireCommit(sql, seedId);

    await sql`UPDATE gitdb.branches SET head_commit = ${seedId}, base_commit = ${seedId} WHERE name = 'main'`;
    await pruneDemoHistory(sql, seedId);
    await dropMigrationLeftovers(sql);
    await sweepMainToIR(sql, target.ir);

    return { state: "reset", commit: seedId };
  });
}
