import type { Column, Constraint, Index, SchemaIR, Table } from "../ir/types.js";
import { sortIR } from "../ir/types.js";
import { canonicalizeTypeString } from "../ir/typecanon.js";

export type SchemaOp =
  | { kind: "create_table"; table: Table }
  | { kind: "drop_table"; table: string }
  | { kind: "add_column"; table: string; column: Column }
  | { kind: "drop_column"; table: string; column: string }
  | { kind: "rename_column"; table: string; from: string; to: string }
  | { kind: "retype_column"; table: string; column: string; from: string; to: string; using?: string }
  | { kind: "set_nullable"; table: string; column: string; nullable: boolean }
  | { kind: "set_default"; table: string; column: string; default: string | null }
  | { kind: "add_constraint"; table: string; constraint: Constraint }
  | { kind: "drop_constraint"; table: string; constraint: string }
  | { kind: "add_index"; table: string; index: Index }
  | { kind: "drop_index"; table: string; index: string };

function byName<T extends { name: string }>(xs: T[]): Map<string, T> {
  return new Map(xs.map((x) => [x.name, x]));
}

function sameConstraint(a: Constraint, b: Constraint): boolean {
  return (
    a.kind === b.kind &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => c === b.columns[i]) &&
    (a.expression ?? null) === (b.expression ?? null) &&
    jsonEqual(a.references ?? null, b.references ?? null)
  );
}

function sameIndex(a: Index, b: Index): boolean {
  return (
    a.unique === b.unique &&
    a.method === b.method &&
    (a.predicate ?? null) === (b.predicate ?? null) &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => c === b.columns[i])
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function columnAlters(table: string, from: Column, to: Column): SchemaOp[] {
  const ops: SchemaOp[] = [];
  const fromType = canonicalizeTypeString(from.type);
  const toType = canonicalizeTypeString(to.type);
  if (fromType !== toType) {
    ops.push({ kind: "retype_column", table, column: to.name, from: fromType, to: toType });
  }
  if (from.nullable !== to.nullable) {
    ops.push({ kind: "set_nullable", table, column: to.name, nullable: to.nullable });
  }
  if (from.default !== to.default) {
    ops.push({ kind: "set_default", table, column: to.name, default: to.default });
  }
  return ops;
}

/**
 * Pair unmatched columns that still share a physical backing column.
 *
 * This is not the Levenshtein heuristic (task 10). It only fires when the IR
 * itself records that `to.physicalName` is the same storage as `from`, which
 * is how a branch view represents a rename. Ambiguous pairings are left as
 * drop+add so a rename is never invented.
 */
function renamePairs(fromOnly: Column[], toOnly: Column[]): { from: Column; to: Column }[] {
  const pairs: { from: Column; to: Column }[] = [];
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();

  for (const f of fromOnly) {
    const matches = toOnly.filter(
      (t) => t.physicalName === f.physicalName || t.physicalName === f.name,
    );
    if (matches.length !== 1) continue;
    const t = matches[0]!;
    const reverse = fromOnly.filter(
      (o) => t.physicalName === o.physicalName || t.physicalName === o.name,
    );
    if (reverse.length !== 1) continue;
    if (usedFrom.has(f.name) || usedTo.has(t.name)) continue;
    usedFrom.add(f.name);
    usedTo.add(t.name);
    pairs.push({ from: f, to: t });
  }
  return pairs;
}

function diffTable(from: Table, to: Table): SchemaOp[] {
  const table = to.name;
  const ops: SchemaOp[] = [];

  const fromCols = byName(from.columns);
  const toCols = byName(to.columns);
  const fromOnly = from.columns.filter((c) => !toCols.has(c.name));
  const toOnly = to.columns.filter((c) => !fromCols.has(c.name));
  const renames = renamePairs(fromOnly, toOnly);
  const renamedFrom = new Set(renames.map((r) => r.from.name));
  const renamedTo = new Set(renames.map((r) => r.to.name));

  const fromIdx = byName(from.indexes);
  const toIdx = byName(to.indexes);
  for (const idx of from.indexes) {
    const next = toIdx.get(idx.name);
    if (!next || !sameIndex(idx, next)) {
      ops.push({ kind: "drop_index", table, index: idx.name });
    }
  }

  const fromCons = byName(from.constraints);
  const toCons = byName(to.constraints);
  for (const c of from.constraints) {
    const next = toCons.get(c.name);
    if (!next || !sameConstraint(c, next)) {
      ops.push({ kind: "drop_constraint", table, constraint: c.name });
    }
  }

  for (const c of fromOnly) {
    if (!renamedFrom.has(c.name)) ops.push({ kind: "drop_column", table, column: c.name });
  }

  for (const r of renames) {
    ops.push({ kind: "rename_column", table, from: r.from.name, to: r.to.name });
  }

  const alterSources: { from: Column; to: Column }[] = [];
  for (const col of to.columns) {
    const prev = fromCols.get(col.name);
    if (prev) alterSources.push({ from: prev, to: col });
  }
  for (const r of renames) alterSources.push({ from: r.from, to: r.to });
  alterSources.sort((a, b) => (a.to.name < b.to.name ? -1 : a.to.name > b.to.name ? 1 : 0));
  for (const { from: a, to: b } of alterSources) ops.push(...columnAlters(table, a, b));

  for (const c of toOnly) {
    if (!renamedTo.has(c.name)) ops.push({ kind: "add_column", table, column: c });
  }

  for (const c of to.constraints) {
    const prev = fromCons.get(c.name);
    if (!prev || !sameConstraint(prev, c)) {
      ops.push({ kind: "add_constraint", table, constraint: c });
    }
  }

  for (const idx of to.indexes) {
    const prev = fromIdx.get(idx.name);
    if (!prev || !sameIndex(prev, idx)) {
      ops.push({ kind: "add_index", table, index: idx });
    }
  }

  return ops;
}

/**
 * Structural diff of two schema IRs. Pure; no catalog access.
 *
 * Column order and `ordinal` are ignored. Types are compared after canonicalisation
 * so `varchar(255)` and `character varying(255)` are the same. Dropping or creating
 * a table is a single op — nested columns/indexes/constraints are not re-emitted.
 */
export function diff(from: SchemaIR, to: SchemaIR): SchemaOp[] {
  const a = sortIR(from);
  const b = sortIR(to);
  const fromTables = byName(a.tables);
  const toTables = byName(b.tables);
  const ops: SchemaOp[] = [];

  for (const t of a.tables) {
    if (!toTables.has(t.name)) ops.push({ kind: "drop_table", table: t.name });
  }

  for (const t of b.tables) {
    const prev = fromTables.get(t.name);
    if (prev) ops.push(...diffTable(prev, t));
  }

  for (const t of b.tables) {
    if (!fromTables.has(t.name)) ops.push({ kind: "create_table", table: t });
  }

  return ops;
}
