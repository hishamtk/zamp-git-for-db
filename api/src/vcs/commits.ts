import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Sql } from "../db.js";
import { hashIR } from "../ir/canonical.js";
import { introspect } from "../ir/introspect.js";
import { SchemaIRSchema, type SchemaIR } from "../ir/types.js";
import { MAIN_BRANCH, MAIN_SCHEMA } from "../ident.js";

export type Commit = {
  id: string;
  parent_id: string | null;
  branch: string;
  message: string;
  ir: SchemaIR;
  created_at: Date;
};

/** Apply the metadata DDL and ensure `main` exists with a commit 0. */
export async function bootstrap(sql: Sql): Promise<void> {
  const ddl = await readFile(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
  await sql.unsafe(ddl);

  const [existing] = await sql`SELECT name FROM gitdb.branches WHERE name = ${MAIN_BRANCH}`;
  if (existing) return;

  const { ir } = await introspect(sql, MAIN_SCHEMA);
  const id = hashIR(ir);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO gitdb.commits (id, parent_id, branch, message, ir)
      VALUES (${id}, NULL, ${MAIN_BRANCH}, 'initial schema', ${tx.json(ir as never)})
      ON CONFLICT (id) DO NOTHING`;
    await tx`
      INSERT INTO gitdb.branches (name, schema_name, head_commit, base_commit)
      VALUES (${MAIN_BRANCH}, ${MAIN_SCHEMA}, ${id}, ${id})
      ON CONFLICT (name) DO NOTHING`;
  });
}

/**
 * Write a commit.
 *
 * The id is the content address of the IR, so committing an unchanged schema is a
 * no-op that returns the existing id - dedup falls out of content addressing rather
 * than needing an equality check.
 */
export async function writeCommit(
  sql: Sql,
  opts: { branch: string; ir: SchemaIR; message: string; parentId: string | null },
): Promise<{ id: string; created: boolean }> {
  const id = hashIR(opts.ir);
  if (id === opts.parentId) return { id, created: false };

  const rows = await sql`
    INSERT INTO gitdb.commits (id, parent_id, branch, message, ir)
    VALUES (${id}, ${opts.parentId}, ${opts.branch}, ${opts.message}, ${sql.json(opts.ir as never)})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;

  await sql`UPDATE gitdb.branches SET head_commit = ${id} WHERE name = ${opts.branch}`;
  return { id, created: rows.length > 0 };
}

export async function getCommit(sql: Sql, id: string): Promise<Commit | null> {
  const [row] = await sql<Commit[]>`SELECT * FROM gitdb.commits WHERE id = ${id}`;
  if (!row) return null;
  return { ...row, ir: SchemaIRSchema.parse(row.ir) };
}

export async function requireCommit(sql: Sql, id: string): Promise<Commit> {
  const c = await getCommit(sql, id);
  if (!c) throw new Error(`no such commit: ${id}`);
  return c;
}

/** Newest-first commit list for a branch. */
export async function log(sql: Sql, branch: string, limit = 50): Promise<Commit[]> {
  const rows = await sql<Commit[]>`
    SELECT * FROM gitdb.commits WHERE branch = ${branch}
     ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, ir: SchemaIRSchema.parse(r.ir) }));
}
