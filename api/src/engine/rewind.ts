import type { Sql } from "../db.js";
import { MAIN_BRANCH } from "../ident.js";
import { isDirty, listBranches, regenerateBranch } from "../vcs/branches.js";

function dirtyConflict(branch: string): Error {
  return Object.assign(new Error(`branch '${branch}' has uncommitted DDL`), {
    statusCode: 409,
    payload: { state: "dirty", branch },
  });
}

/** Rewind mutates main; refuse if a feature branch would lose uncommitted work. */
export async function assertBranchesAllowRewind(sql: Sql): Promise<void> {
  for (const branch of await listBranches(sql)) {
    if (branch.name === MAIN_BRANCH) continue;
    if (await isDirty(sql, branch.name)) throw dirtyConflict(branch.name);
  }
}

/** Rebuild feature-branch views against the post-rewind main catalog. */
export async function regenerateFeatureBranches(sql: Sql): Promise<void> {
  for (const branch of await listBranches(sql)) {
    if (branch.name === MAIN_BRANCH) continue;
    await regenerateBranch(sql, branch.name);
  }
}
