import type { Sql } from "../db.js";
import { MAIN_SCHEMA, qid, qname } from "../ident.js";
import type { SchemaIR } from "../ir/types.js";

const SHADOW_COLUMN = /__(?:new|old_)/;

async function tryDDL(sql: Sql, ddl: string): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '2s'");
      await tx.unsafe(ddl);
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "55P03" || code === "40P01") return;
    throw error;
  }
}

/** Expand/cutover leftovers that are not part of `target`. */
export async function leftoverShadowColumns(
  sql: Sql,
  target: SchemaIR,
): Promise<{ table: string; column: string }[]> {
  const keep = new Map(target.tables.map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${MAIN_SCHEMA}
       AND c.relkind = 'r'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND (a.attname ~ '__new$' OR a.attname ~ '__old_')`;
  return cols
    .filter((col) => SHADOW_COLUMN.test(col.column_name) && !keep.get(col.table_name)?.has(col.column_name))
    .map((col) => ({ table: col.table_name, column: col.column_name }));
}

/** Drop expand/cutover leftovers so a later reset expand does not collide. */
export async function dropMigrationLeftovers(sql: Sql): Promise<void> {
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    SELECT c.relname AS table_name, a.attname AS column_name
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${MAIN_SCHEMA}
       AND c.relkind = 'r'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND (a.attname ~ '__new$' OR a.attname ~ '__old_')`;
  for (const col of cols) {
    if (!SHADOW_COLUMN.test(col.column_name)) continue;
    await tryDDL(
      sql,
      `ALTER TABLE ${qname(MAIN_SCHEMA, col.table_name)} DROP COLUMN IF EXISTS ${qid(col.column_name)} CASCADE`,
    );
  }

  const fns = await sql<{ proname: string }[]>`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'gitdb' AND p.proname LIKE 'sync_%'`;
  for (const fn of fns) {
    await tryDDL(sql, `DROP FUNCTION IF EXISTS gitdb.${qid(fn.proname)} CASCADE`);
  }
}

/** Drop main tables/columns that are not in the seed IR. */
export async function sweepMainToIR(sql: Sql, target: SchemaIR): Promise<void> {
  const keepTables = new Set(target.tables.map((table) => table.name));
  const live = await sql<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${MAIN_SCHEMA} AND c.relkind = 'r'`;
  for (const row of live) {
    if (keepTables.has(row.relname)) continue;
    await tryDDL(sql, `DROP TABLE IF EXISTS ${qname(MAIN_SCHEMA, row.relname)} CASCADE`);
  }

  for (const table of target.tables) {
    const keepCols = new Set(table.columns.map((column) => column.name));
    const cols = await sql<{ attname: string }[]>`
      SELECT a.attname
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${MAIN_SCHEMA}
         AND c.relname = ${table.name}
         AND a.attnum > 0
         AND NOT a.attisdropped`;
    for (const col of cols) {
      if (keepCols.has(col.attname)) continue;
      await tryDDL(
        sql,
        `ALTER TABLE ${qname(MAIN_SCHEMA, table.name)} DROP COLUMN IF EXISTS ${qid(col.attname)} CASCADE`,
      );
    }
  }
}

/**
 * Wipe merge jobs and any commit that is not the seed or an ancestor of it.
 * Call after main.head_commit already points at the seed.
 */
export async function pruneDemoHistory(sql: Sql, seedId: string): Promise<void> {
  await sql`DELETE FROM gitdb.merges`;
  const keep = await sql<{ id: string }[]>`
    WITH RECURSIVE keep AS (
      SELECT id, parent_id FROM gitdb.commits WHERE id = ${seedId}
      UNION ALL
      SELECT c.id, c.parent_id
        FROM gitdb.commits c
        JOIN keep k ON c.id = k.parent_id
    )
    SELECT id FROM keep`;
  const ids = keep.map((row) => row.id);
  if (!ids.length) return;
  await sql`DELETE FROM gitdb.commits WHERE id NOT IN ${sql(ids)}`;
}
