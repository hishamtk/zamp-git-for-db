import { qid, qname, assertTypeExpr, MAIN_SCHEMA } from "../ident.js";
import type { SchemaIR, Table } from "../ir/types.js";
import { findTable } from "../ir/types.js";

/**
 * Generating the SQL that makes a branch a virtual schema overlay.
 *
 * A branch is one view per table, selecting from the parent's physical tables. No
 * data is copied. Measured: 4ms and 0 bytes for a branch over a 4GB table, with a
 * point lookup through the view running in 0.009ms because Postgres inlines simple
 * views and pushes predicates down to the base table's indexes.
 *
 * Schema drift is expressed in the view's select list rather than by touching the
 * physical table:
 *
 *   add column      NULL::type AS name
 *   drop column     omitted
 *   rename          physical AS logical
 *   retype          physical::type AS logical
 *
 * Constraints and indexes declared on a branch live only in the IR. Postgres cannot
 * attach either to a view, and branches share physical storage with main, so
 * branch-local enforcement would be incoherent - two branches could demand
 * contradictory constraints over the same rows. See decisions.md entry 13.
 */

export type ViewPlan = {
  /** Tables that exist in main and are projected as views. */
  views: { table: string; sql: string }[];
  /** Tables introduced by the branch; these are real, empty, physical tables. */
  ownTables: Table[];
  /** Table names present in main but dropped by the branch. */
  dropped: string[];
};

/**
 * Build the select list projecting a parent table into a branch's shape.
 * Returns null when the branch's table has no columns backed by the parent.
 */
export function selectListFor(branchTable: Table, parentTable: Table): string {
  const parentPhysical = new Set(parentTable.columns.map((c) => c.name));
  const items: string[] = [];

  for (const col of branchTable.columns) {
    const physical = col.physicalName;
    const alias = qid(col.name);

    if (!parentPhysical.has(physical)) {
      // Column added in this branch: no physical backing, so project a typed
      // placeholder. The value materialises for real at merge/backfill.
      const expr = col.default ?? `NULL::${assertTypeExpr(col.type)}`;
      items.push(`${expr} AS ${alias}`);
      continue;
    }

    const parentCol = parentTable.columns.find((c) => c.name === physical)!;
    if (parentCol.type !== col.type) {
      // Retyped in this branch: cast in the projection. Note this makes the column
      // non-updatable through the view until the change is merged.
      items.push(`${qid(physical)}::${assertTypeExpr(col.type)} AS ${alias}`);
    } else if (physical !== col.name) {
      items.push(`${qid(physical)} AS ${alias}`);
    } else {
      items.push(qid(physical));
    }
  }

  return items.join(", ");
}

/**
 * Always plain `CREATE VIEW`, never `CREATE OR REPLACE`.
 *
 * `CREATE OR REPLACE VIEW` can only add trailing columns - it rejects renames and
 * removals with `42P16: cannot change name of view column`. Since renaming and
 * dropping columns is most of what a branch does, every caller drops first and
 * recreates. Using the plain form makes that contract explicit and turns a missing
 * DROP into an immediate error rather than a confusing one.
 */
export function createViewSQL(
  branchSchema: string,
  branchTable: Table,
  parentTable: Table,
  parentSchema = MAIN_SCHEMA,
): string {
  const list = selectListFor(branchTable, parentTable);
  return `CREATE VIEW ${qname(branchSchema, branchTable.name)} AS SELECT ${list} FROM ${qname(parentSchema, parentTable.name)}`;
}

export function createTableSQL(schema: string, table: Table): string {
  const cols = table.columns.map((c) => {
    const parts = [qid(c.name), assertTypeExpr(c.type)];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.default) parts.push(`DEFAULT ${c.default}`);
    return parts.join(" ");
  });
  const pk = table.constraints.find((k) => k.kind === "primary");
  if (pk) cols.push(`PRIMARY KEY (${pk.columns.map(qid).join(", ")})`);
  return `CREATE TABLE ${qname(schema, table.name)} (${cols.join(", ")})`;
}

/**
 * Work out what a branch schema should contain, given the branch's target IR and
 * the parent's current IR.
 */
export function planViews(branchIR: SchemaIR, parentIR: SchemaIR): ViewPlan {
  const views: { table: string; sql: string }[] = [];
  const ownTables: Table[] = [];

  for (const t of branchIR.tables) {
    const parent = findTable(parentIR, t.name);
    if (parent) views.push({ table: t.name, sql: "" });
    else ownTables.push(t);
  }

  const branchNames = new Set(branchIR.tables.map((t) => t.name));
  const dropped = parentIR.tables.filter((t) => !branchNames.has(t.name)).map((t) => t.name);

  return { views, ownTables, dropped };
}

/**
 * Full DDL to materialise a branch schema from scratch.
 *
 * `CREATE SCHEMA` plus one statement per table. Every statement is metadata-only,
 * so the whole thing runs in single-digit milliseconds regardless of table size.
 */
export function branchDDL(branchSchema: string, branchIR: SchemaIR, parentIR: SchemaIR): string[] {
  const out: string[] = [`CREATE SCHEMA IF NOT EXISTS ${qid(branchSchema)}`];

  for (const t of branchIR.tables) {
    const parent = findTable(parentIR, t.name);
    out.push(parent ? createViewSQL(branchSchema, t, parent) : createTableSQL(branchSchema, t));
  }
  return out;
}

/**
 * Regenerate every view in a branch against a (possibly changed) parent.
 *
 * `CREATE OR REPLACE VIEW` cannot change a view's column set, so views are dropped
 * and recreated. Callers run this inside one transaction, which keeps the swap
 * atomic from any concurrent reader's point of view.
 */
export function regenerateDDL(branchSchema: string, branchIR: SchemaIR, parentIR: SchemaIR): string[] {
  const out: string[] = [];
  for (const t of branchIR.tables) {
    const parent = findTable(parentIR, t.name);
    if (!parent) continue; // branch-owned physical table; leave it alone
    out.push(`DROP VIEW IF EXISTS ${qname(branchSchema, t.name)}`);
    out.push(createViewSQL(branchSchema, t, parent));
  }
  return out;
}

/**
 * Columns a branch's views read from the parent.
 *
 * Used before a destructive change to main: if a branch still projects a column
 * that is about to disappear, the branch must be regenerated or marked stale.
 */
export function referencedPhysicalColumns(branchIR: SchemaIR, table: string): Set<string> {
  const t = findTable(branchIR, table);
  if (!t) return new Set();
  return new Set(t.columns.map((c) => c.physicalName));
}
