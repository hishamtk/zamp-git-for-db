import { diff, type SchemaOp } from "../diff/diff.js";
import { canonicalizeTypeString } from "../ir/typecanon.js";
import type { Column, Constraint, Index, SchemaIR, Table } from "../ir/types.js";
import { sortIR } from "../ir/types.js";

export type MergeConflict = {
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
  reason: string;
};

export type MergeResult = { ops: SchemaOp[]; conflicts?: undefined } | { ops?: undefined; conflicts: MergeConflict[] };

type Node =
  | { kind: "table"; name: string }
  | { kind: "column"; table: string; column: Column }
  | { kind: "constraint"; table: string; constraint: Constraint }
  | { kind: "index"; table: string; index: Index };

function colValue(c: Column) {
  return {
    default: c.default,
    name: c.name,
    nullable: c.nullable,
    physicalName: c.physicalName,
    type: canonicalizeTypeString(c.type),
  };
}

function consValue(c: Constraint) {
  return {
    columns: [...c.columns],
    expression: c.expression ?? null,
    kind: c.kind,
    name: c.name,
    references: c.references
      ? { columns: [...c.references.columns], table: c.references.table }
      : null,
    validated: c.validated,
  };
}

function idxValue(i: Index) {
  return {
    columns: [...i.columns],
    method: i.method,
    name: i.name,
    predicate: i.predicate ?? null,
    unique: i.unique,
  };
}

function encode(node: Node): string {
  switch (node.kind) {
    case "table":
      return JSON.stringify({ k: "table", name: node.name });
    case "column":
      return JSON.stringify({ k: "column", v: colValue(node.column) });
    case "constraint":
      return JSON.stringify({ k: "constraint", v: consValue(node.constraint) });
    case "index":
      return JSON.stringify({ k: "index", v: idxValue(node.index) });
  }
}

function indexIR(ir: SchemaIR): Map<string, { json: string; node: Node }> {
  const map = new Map<string, { json: string; node: Node }>();
  for (const t of ir.tables) {
    const tableNode: Node = { kind: "table", name: t.name };
    map.set(t.name, { json: encode(tableNode), node: tableNode });
    for (const c of t.columns) {
      const path = `${t.name}.${c.name}`;
      const node: Node = { kind: "column", table: t.name, column: c };
      map.set(path, { json: encode(node), node });
    }
    for (const c of t.constraints) {
      const path = `${t.name}.constraint.${c.name}`;
      const node: Node = { kind: "constraint", table: t.name, constraint: c };
      map.set(path, { json: encode(node), node });
    }
    for (const i of t.indexes) {
      const path = `${t.name}.index.${i.name}`;
      const node: Node = { kind: "index", table: t.name, index: i };
      map.set(path, { json: encode(node), node });
    }
  }
  return map;
}

function decodePayload(entry: { json: string; node: Node } | undefined): unknown {
  if (!entry) return null;
  switch (entry.node.kind) {
    case "table":
      return { table: entry.node.name };
    case "column":
      return colValue(entry.node.column);
    case "constraint":
      return consValue(entry.node.constraint);
    case "index":
      return idxValue(entry.node.index);
  }
}

function prose(path: string): string {
  if (path.includes(".constraint.")) return `constraint ${path}`;
  if (path.includes(".index.")) return `index ${path}`;
  if (path.includes(".")) return `column ${path}`;
  return `table ${path}`;
}

/**
 * Three-way merge using `base` as the sole ancestor (no LCA walk).
 *
 * `ops` is `diff(ours, merged)` — the work to apply onto the target (`main`)
 * to incorporate `theirs`. Conflicts are never auto-resolved.
 */
export function merge(base: SchemaIR, ours: SchemaIR, theirs: SchemaIR): MergeResult {
  const B = indexIR(sortIR(base));
  const O = indexIR(sortIR(ours));
  const T = indexIR(sortIR(theirs));
  const paths = new Set([...B.keys(), ...O.keys(), ...T.keys()]);

  const conflicts: MergeConflict[] = [];
  const chosen = new Map<string, Node>();

  for (const path of [...paths].sort()) {
    const b = B.get(path);
    const o = O.get(path);
    const t = T.get(path);
    const bj = b?.json ?? null;
    const oj = o?.json ?? null;
    const tj = t?.json ?? null;

    const oursSame = oj === bj;
    const theirsSame = tj === bj;
    const equal = oj === tj;

    let pick: { json: string; node: Node } | undefined;
    if (oursSame && theirsSame) {
      pick = o ?? b;
    } else if (oursSame && !theirsSame) {
      pick = t;
    } else if (!oursSame && theirsSame) {
      pick = o;
    } else if (equal) {
      pick = o ?? t;
    } else {
      conflicts.push({
        path,
        base: decodePayload(b),
        ours: decodePayload(o),
        theirs: decodePayload(t),
        reason: `both sides changed ${prose(path)} differently`,
      });
      continue;
    }

    if (pick) chosen.set(path, pick.node);
  }

  if (conflicts.length) return { conflicts };

  const tables = new Map<string, Table>();
  for (const node of chosen.values()) {
    if (node.kind !== "table") continue;
    tables.set(node.name, { name: node.name, columns: [], constraints: [], indexes: [] });
  }
  for (const node of chosen.values()) {
    if (node.kind === "table") continue;
    const tbl = tables.get(node.table);
    if (!tbl) continue;
    if (node.kind === "column") tbl.columns.push(node.column);
    else if (node.kind === "constraint") tbl.constraints.push(node.constraint);
    else tbl.indexes.push(node.index);
  }

  const merged = sortIR({ version: 1, tables: [...tables.values()] });
  return { ops: diff(ours, merged) };
}
