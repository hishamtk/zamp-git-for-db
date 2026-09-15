import { createHash } from "node:crypto";
import type { Column, Constraint, Index, SchemaIR, Table } from "./types.js";
import { sortIR } from "./types.js";

/**
 * Canonical serialisation of a Schema IR.
 *
 * Requirements this has to satisfy:
 *  - byte-stable across processes and Node versions, since commit ids are derived
 *    from it and must be comparable forever;
 *  - insensitive to column ORDER (not semantic in Postgres);
 *  - sensitive to every semantic field.
 *
 * `JSON.stringify` is not sufficient on its own: it preserves insertion order of
 * object keys. Every object below is therefore constructed field-by-field in a
 * fixed order rather than spread from its source.
 */

function canonColumn(c: Column) {
  // `ordinal` is deliberately absent: reordering columns must not change the hash.
  return {
    default: c.default,
    name: c.name,
    nullable: c.nullable,
    physicalName: c.physicalName,
    type: c.type,
  };
}

function canonConstraint(c: Constraint) {
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

function canonIndex(i: Index) {
  return {
    columns: [...i.columns],
    method: i.method,
    name: i.name,
    predicate: i.predicate ?? null,
    unique: i.unique,
  };
}

function canonTable(t: Table) {
  return {
    columns: t.columns.map(canonColumn),
    constraints: t.constraints.map(canonConstraint),
    indexes: t.indexes.map(canonIndex),
    name: t.name,
  };
}

/** Deterministic JSON. Sorted collections, fixed key order, no whitespace. */
export function canonicalJSON(ir: SchemaIR): string {
  const sorted = sortIR(ir);
  return JSON.stringify({
    tables: sorted.tables.map(canonTable),
    version: sorted.version,
  });
}

/** Content address of a schema state. This is the commit id. */
export function hashIR(ir: SchemaIR): string {
  return createHash("sha256").update(canonicalJSON(ir), "utf8").digest("hex");
}

export function irEquals(a: SchemaIR, b: SchemaIR): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}
