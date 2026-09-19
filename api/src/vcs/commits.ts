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

async function metadataSql(): Promise<string> {
  const nearby = fileURLToPath(new URL("./schema.sql", import.meta.url));
  try {
    return await readFile(nearby, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return readFile(fileURLToPath(new URL("../../src/vcs/schema.sql", import.meta.url)), "utf8");
  }
}

/** Apply the metadata DDL and ensure `main` exists with a commit 0. */
export async function bootstrap(sql: Sql): Promise<void> {
  const ddl = await metadataSql();
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

/**
 * First shared commit walking `parent_id` from `right` toward root, after
 * collecting every ancestor of `left` (including `left` itself).
 */
export function lowestCommonAncestorId(
  parents: Map<string, string | null>,
  left: string,
  right: string,
): string | null {
  const ancestors = new Set<string>();
  for (let id: string | null = left; id && !ancestors.has(id); ) {
    ancestors.add(id);
    if (!parents.has(id)) break;
    id = parents.get(id) ?? null;
  }
  const seen = new Set<string>();
  for (let id: string | null = right; id && !seen.has(id); ) {
    if (ancestors.has(id)) return id;
    seen.add(id);
    if (!parents.has(id)) break;
    id = parents.get(id) ?? null;
  }
  return null;
}

export async function lowestCommonAncestor(sql: Sql, left: string, right: string): Promise<Commit> {
  const rows = await sql<{ id: string; parent_id: string | null }[]>`
    SELECT id, parent_id FROM gitdb.commits`;
  const id = lowestCommonAncestorId(new Map(rows.map((row) => [row.id, row.parent_id])), left, right);
  if (!id) {
    throw Object.assign(new Error("no common ancestor between the two branches"), {
      statusCode: 409,
      code: "no_common_ancestor",
    });
  }
  return requireCommit(sql, id);
}

/** Newest-first commit list for a branch. */
export async function log(sql: Sql, branch: string, limit = 50): Promise<Commit[]> {
  const rows = await sql<Commit[]>`
    SELECT * FROM gitdb.commits WHERE branch = ${branch}
     ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, ir: SchemaIRSchema.parse(r.ir) }));
}

/** Tables created by `infra/seed.mjs`. Reset must never compile these as DROP TABLE. */
export const SEED_TABLES = ["accounts", "cards", "disputes", "merchants", "txns"] as const;

export async function rememberDemoSeed(sql: Sql, commitId: string): Promise<void> {
  await sql`
    INSERT INTO gitdb.demo_seed (id, commit_id) VALUES (1, ${commitId})
    ON CONFLICT (id) DO UPDATE SET commit_id = EXCLUDED.commit_id`;
}

/**
 * The demo snapshot to restore — the earliest commit that contains the most
 * seeded tables. Commit 0 is only that snapshot when seed ran before bootstrap.
 */
export async function resolveDemoSeedCommit(sql: Sql): Promise<string> {
  const [named] = await sql<{ id: string }[]>`
    SELECT id FROM gitdb.commits
     WHERE branch = ${MAIN_BRANCH} AND message = 'seeded catalog'
     ORDER BY created_at DESC LIMIT 1`;
  const [fullest] = await sql<{ id: string }[]>`
    SELECT id FROM gitdb.commits
     WHERE branch = ${MAIN_BRANCH}
     ORDER BY (
       SELECT count(*) FROM jsonb_array_elements(ir->'tables') AS t
        WHERE t->>'name' IN ('accounts', 'cards', 'disputes', 'merchants', 'txns')
     ) DESC, created_at ASC
     LIMIT 1`;
  const seedId = named?.id ?? fullest?.id;
  if (!seedId) throw new Error("main has no seed commit");
  await rememberDemoSeed(sql, seedId);
  return seedId;
}
