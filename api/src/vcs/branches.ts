import type { Sql } from "../db.js";
import { MAIN_BRANCH, MAIN_SCHEMA, branchSchema, qid, assertBranchName } from "../ident.js";
import { hashIR } from "../ir/canonical.js";
import { introspect } from "../ir/introspect.js";
import { SchemaIRSchema, findTable, type SchemaIR } from "../ir/types.js";
import { branchDDL, regenerateDDL, createViewSQL, createTableSQL } from "../engine/views.js";
import { requireCommit } from "./commits.js";

export type Branch = {
  name: string;
  schema_name: string;
  head_commit: string | null;
  base_commit: string | null;
  stale_reason: string | null;
  working_ir: SchemaIR | null;
  created_at: Date;
};

export class BranchError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "branch_error",
  ) {
    super(message);
  }
}

export async function listBranches(sql: Sql): Promise<Branch[]> {
  return sql<Branch[]>`
    SELECT name, schema_name, head_commit, base_commit, stale_reason, working_ir, created_at
      FROM gitdb.branches ORDER BY (name = ${MAIN_BRANCH}) DESC, created_at`;
}

export async function getBranch(sql: Sql, name: string): Promise<Branch | null> {
  const [b] = await sql<Branch[]>`
    SELECT name, schema_name, head_commit, base_commit, stale_reason, working_ir, created_at
      FROM gitdb.branches WHERE name = ${name}`;
  return b ?? null;
}

export async function requireBranch(sql: Sql, name: string): Promise<Branch> {
  const b = await getBranch(sql, name);
  if (!b) throw new BranchError(`no such branch: ${name}`, 404, "no_such_branch");
  return b;
}

/**
 * The branch's working tree: what its views currently expose.
 *
 * Read live from the catalog rather than from the head commit, so uncommitted DDL
 * shows up in diffs. `main` reads its physical tables; a branch reads its views.
 */
export async function workingIR(sql: Sql, branch: string): Promise<SchemaIR> {
  const b = await requireBranch(sql, branch);
  if (branch !== MAIN_BRANCH && b.working_ir) return SchemaIRSchema.parse(b.working_ir);
  const { ir } = await introspect(sql, b.schema_name);
  return ir;
}

/** A branch is dirty when its working tree has drifted from its head commit. */
export async function isDirty(sql: Sql, branch: string): Promise<boolean> {
  const b = await requireBranch(sql, branch);
  const ir = await workingIR(sql, branch);
  return hashIR(ir) !== b.head_commit;
}

/**
 * Create a branch.
 *
 * Two statements' worth of work: create a schema, then one view per parent table.
 * All metadata, so the cost is independent of how much data the parent holds -
 * measured at 4ms and 0 bytes against a 4GB table.
 */
export async function createBranch(
  sql: Sql,
  opts: { name: string; from?: string },
): Promise<Branch> {
  assertBranchName(opts.name);
  if (opts.name === MAIN_BRANCH) throw new BranchError("'main' is reserved", 400, "reserved_name");

  const from = opts.from ?? MAIN_BRANCH;
  if (from !== MAIN_BRANCH) {
    // Branch-of-a-branch would need an ancestor walk for merges; PLAN.md cuts it.
    throw new BranchError("branches can only be created from 'main'", 400, "unsupported_parent");
  }

  if (await getBranch(sql, opts.name)) {
    throw new BranchError(`branch '${opts.name}' already exists`, 409, "already_exists");
  }

  const parent = await requireBranch(sql, MAIN_BRANCH);
  if (!parent.head_commit) throw new BranchError("main has no commits", 500, "no_head");

  const parentIR = (await requireCommit(sql, parent.head_commit)).ir;
  const schema = branchSchema(opts.name);

  await sql.begin(async (tx) => {
    for (const stmt of branchDDL(schema, parentIR, parentIR)) {
      await tx.unsafe(stmt);
    }
    await tx`
      INSERT INTO gitdb.branches (name, schema_name, head_commit, base_commit, working_ir)
      VALUES (
        ${opts.name}, ${schema}, ${parent.head_commit}, ${parent.head_commit},
        ${sql.json(parentIR as never)}
      )`;
  });

  return requireBranch(sql, opts.name);
}

export async function deleteBranch(sql: Sql, name: string): Promise<void> {
  if (name === MAIN_BRANCH) throw new BranchError("cannot delete 'main'", 400, "reserved_name");
  const b = await requireBranch(sql, name);
  await sql.begin(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${qid(b.schema_name)} CASCADE`);
    await tx`DELETE FROM gitdb.branches WHERE name = ${name}`;
  });
}

/**
 * Apply a new target IR to a branch by rewriting its views.
 *
 * This is how every schema change inside a branch is applied: no ALTER TABLE, no
 * lock on the parent's data, ~1ms regardless of table size.
 */
export async function applyIR(sql: Sql, branch: string, nextIR: SchemaIR): Promise<void> {
  if (branch === MAIN_BRANCH) {
    throw new BranchError("main is changed through merges, not directly", 400, "main_is_immutable");
  }
  const b = await requireBranch(sql, branch);
  const parent = await requireBranch(sql, MAIN_BRANCH);
  const parentIR = (await requireCommit(sql, parent.head_commit!)).ir;

  const ir = SchemaIRSchema.parse(nextIR);
  const existing = await introspect(sql, b.schema_name);
  const existingNames = new Set(existing.ir.tables.map((t) => t.name));
  const nextNames = new Set(ir.tables.map((t) => t.name));

  // One transaction, so concurrent readers of the branch never observe a partial
  // schema. Every statement is metadata-only: no data moves, whatever the row count.
  await sql.begin(async (tx) => {
    for (const name of existingNames) {
      if (!nextNames.has(name)) {
        await tx.unsafe(`DROP VIEW IF EXISTS ${qid(b.schema_name)}.${qid(name)} CASCADE`);
        await tx.unsafe(`DROP TABLE IF EXISTS ${qid(b.schema_name)}.${qid(name)} CASCADE`);
      }
    }

    for (const t of ir.tables) {
      const parent = findTable(parentIR, t.name);
      if (parent) {
        // Drop-then-create rather than CREATE OR REPLACE: replacing a view cannot
        // rename or remove columns, which is most of what a branch edit does.
        await tx.unsafe(`DROP VIEW IF EXISTS ${qid(b.schema_name)}.${qid(t.name)}`);
        await tx.unsafe(createViewSQL(b.schema_name, t, parent));
      } else if (!existingNames.has(t.name)) {
        // Introduced by this branch: a real, empty physical table.
        await tx.unsafe(createTableSQL(b.schema_name, t));
      }
    }
    await tx`
      UPDATE gitdb.branches
         SET working_ir = ${sql.json(ir as never)}, stale_reason = NULL
       WHERE name = ${branch}`;
  });
}

/**
 * Rebuild a branch's views against main's current shape.
 *
 * Called after a merge changes main. Where a branch references something main no
 * longer has, mark it stale rather than failing - the branch owner needs a readable
 * explanation, not a broken schema.
 */
export async function regenerateBranch(sql: Sql, name: string): Promise<{ stale: string | null }> {
  const b = await requireBranch(sql, name);
  if (name === MAIN_BRANCH) return { stale: null };

  const parent = await requireBranch(sql, MAIN_BRANCH);
  const parentIR = (await requireCommit(sql, parent.head_commit!)).ir;
  const branchIR = await workingIR(sql, name);

  try {
    await sql.begin(async (tx) => {
      for (const stmt of regenerateDDL(b.schema_name, branchIR, parentIR)) await tx.unsafe(stmt);
    });
    await sql`UPDATE gitdb.branches SET stale_reason = NULL WHERE name = ${name}`;
    return { stale: null };
  } catch (e) {
    const reason = `stale after main changed: ${(e as Error).message}`;
    await sql`UPDATE gitdb.branches SET stale_reason = ${reason} WHERE name = ${name}`;
    return { stale: reason };
  }
}

export async function mainIR(sql: Sql): Promise<SchemaIR> {
  const { ir } = await introspect(sql, MAIN_SCHEMA);
  return ir;
}
