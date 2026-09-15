import type { Sql } from "../db.js";
import { canonicalFromCatalog } from "./typecanon.js";
import type { Column, Constraint, Index, SchemaIR, Table } from "./types.js";
import { sortIR } from "./types.js";

/**
 * Read a schema's true state from `pg_catalog`.
 *
 * `pg_catalog` is queried directly rather than `information_schema`, which is a
 * portability veneer over the same data: slower, and lossy about the things that
 * matter here (partial index predicates, NOT VALID constraints, generated columns).
 *
 * Both physical tables (in `main`) and views (in a branch schema) are read, since a
 * branch presents its schema entirely as views. Columns are attributed identically
 * in `pg_attribute` either way, so one query covers both.
 */

export type Unsupported = { kind: string; name: string; reason: string };

export type IntrospectResult = {
  ir: SchemaIR;
  /** Objects outside the whitelist. Surfaced, never silently dropped. */
  unsupported: Unsupported[];
};

const WHITELISTED_RELKINDS = ["r", "v"] as const; // ordinary table, view

export async function introspect(sql: Sql, schema: string): Promise<IntrospectResult> {
  const unsupported: Unsupported[] = [];

  const relations = await sql<
    { oid: number; relname: string; relkind: string }[]
  >`
    SELECT c.oid::int AS oid, c.relname, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND c.relkind = ANY(ARRAY['r','v','p','m','f'])
     ORDER BY c.relname
  `;

  const tables: Table[] = [];

  for (const rel of relations) {
    if (!WHITELISTED_RELKINDS.includes(rel.relkind as "r" | "v")) {
      unsupported.push({
        kind: relkindLabel(rel.relkind),
        name: rel.relname,
        reason: `${relkindLabel(rel.relkind)} is outside the supported object set`,
      });
      continue;
    }

    const columns = await introspectColumns(sql, rel.oid);
    const constraints = rel.relkind === "r" ? await introspectConstraints(sql, rel.oid, unsupported) : [];
    const indexes = rel.relkind === "r" ? await introspectIndexes(sql, rel.oid, unsupported) : [];

    tables.push({ name: rel.relname, columns, constraints, indexes });
  }

  return { ir: sortIR({ version: 1, tables }), unsupported };
}

function relkindLabel(k: string): string {
  return (
    { r: "table", v: "view", p: "partitioned table", m: "materialized view", f: "foreign table" }[k] ??
    `relkind ${k}`
  );
}

async function introspectColumns(sql: Sql, oid: number): Promise<Column[]> {
  const rows = await sql<
    {
      attname: string;
      attnum: number;
      typname: string;
      formatted: string;
      attnotnull: boolean;
      default_expr: string | null;
      attgenerated: string;
    }[]
  >`
    SELECT a.attname,
           a.attnum,
           t.typname,
           format_type(a.atttypid, a.atttypmod) AS formatted,
           a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid)      AS default_expr,
           a.attgenerated::text                 AS attgenerated
      FROM pg_attribute a
      JOIN pg_type t       ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ${oid}
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum
  `;

  return rows.map((r) => ({
    name: r.attname,
    // At rest the logical and physical names coincide. The migration engine is the
    // only thing that makes them diverge, and it rewrites the IR when it does.
    physicalName: r.attname,
    type: canonicalFromCatalog(r.typname, r.formatted),
    nullable: !r.attnotnull,
    default: r.default_expr,
    ordinal: r.attnum,
  }));
}

async function introspectConstraints(
  sql: Sql,
  oid: number,
  unsupported: Unsupported[],
): Promise<Constraint[]> {
  const rows = await sql<
    {
      conname: string;
      contype: string;
      convalidated: boolean;
      columns: string[] | null;
      expression: string | null;
      ref_table: string | null;
      ref_columns: string[] | null;
    }[]
  >`
    SELECT c.conname,
           c.contype::text  AS contype,
           c.convalidated,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           ) AS columns,
           CASE WHEN c.contype = 'c' THEN pg_get_expr(c.conbin, c.conrelid) END AS expression,
           CASE WHEN c.contype = 'f' THEN rc.relname END AS ref_table,
           CASE WHEN c.contype = 'f' THEN (
             SELECT array_agg(a.attname ORDER BY k.ord)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
           ) END AS ref_columns
      FROM pg_constraint c
      LEFT JOIN pg_class rc ON rc.oid = c.confrelid
     WHERE c.conrelid = ${oid}
     ORDER BY c.conname
  `;

  const kinds: Record<string, Constraint["kind"]> = { p: "primary", u: "unique", c: "check", f: "foreign" };
  const out: Constraint[] = [];

  for (const r of rows) {
    const kind = kinds[r.contype];
    if (!kind) {
      unsupported.push({
        kind: "constraint",
        name: r.conname,
        reason: `constraint type '${r.contype}' is not supported (exclusion constraints and triggers are out of scope)`,
      });
      continue;
    }
    out.push({
      name: r.conname,
      kind,
      columns: r.columns ?? [],
      expression: r.expression ?? null,
      references: r.ref_table ? { table: r.ref_table, columns: r.ref_columns ?? [] } : null,
      validated: r.convalidated,
    });
  }
  return out;
}

async function introspectIndexes(sql: Sql, oid: number, unsupported: Unsupported[]): Promise<Index[]> {
  const rows = await sql<
    {
      relname: string;
      amname: string;
      indisunique: boolean;
      indisprimary: boolean;
      columns: string[] | null;
      predicate: string | null;
      is_expression: boolean;
    }[]
  >`
    SELECT ic.relname,
           am.amname,
           i.indisunique,
           i.indisprimary,
           (SELECT array_agg(a.attname ORDER BY k.ord)
              FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           ) AS columns,
           pg_get_expr(i.indpred, i.indrelid) AS predicate,
           (i.indexprs IS NOT NULL)           AS is_expression
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_am am    ON am.oid = ic.relam
     WHERE i.indrelid = ${oid}
     ORDER BY ic.relname
  `;

  const out: Index[] = [];
  for (const r of rows) {
    // Primary-key and unique-constraint indexes are represented by their constraint;
    // emitting both would produce a duplicate op on every diff.
    if (r.indisprimary) continue;

    if (r.amname !== "btree") {
      unsupported.push({ kind: "index", name: r.relname, reason: `index method '${r.amname}' is not supported (btree only)` });
      continue;
    }
    if (r.is_expression) {
      unsupported.push({ kind: "index", name: r.relname, reason: "expression indexes are not supported" });
      continue;
    }

    out.push({
      name: r.relname,
      columns: r.columns ?? [],
      unique: r.indisunique,
      method: "btree",
      predicate: r.predicate ?? null,
    });
  }
  return out;
}
