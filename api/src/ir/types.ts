import { z } from "zod";

/**
 * The Schema IR: a canonical, ordered description of a schema.
 *
 * Two rules give the IR its useful properties, and both are load-bearing:
 *
 *  - Collections are sorted by NAME, never by ordinal position. Column order is not
 *    semantic in Postgres, so reordering columns must produce an empty diff.
 *  - `Column.ordinal` is informational only and is EXCLUDED from the canonical form.
 *    It exists solely as a signal for rename detection.
 */

export const ColumnSchema = z.object({
  name: z.string(),
  /**
   * The physical column currently backing this logical column.
   *
   * Equal to `name` at rest, but diverges mid-migration: after an expand step the
   * logical `amount` may be backed by physical `amount_cents` until cutover.
   *
   * Recording this per commit is what makes archive-on-contract a later bolt-on
   * rather than a rewrite - without it the history of which physical column held
   * which values is lost. See decisions.md entry 10.
   */
  physicalName: z.string(),
  /** Canonical type, e.g. `pg_catalog.int4`, `pg_catalog.varchar(255)`. */
  type: z.string(),
  nullable: z.boolean(),
  /** Canonical default expression text, or null. */
  default: z.string().nullable(),
  /** Informational. Excluded from the canonical form and therefore from the hash. */
  ordinal: z.number().int(),
});

export const ConstraintSchema = z.object({
  name: z.string(),
  kind: z.enum(["primary", "unique", "check", "foreign"]),
  columns: z.array(z.string()),
  /** For `check` constraints: the canonical expression text. */
  expression: z.string().nullable().default(null),
  references: z
    .object({ table: z.string(), columns: z.array(z.string()) })
    .nullable()
    .default(null),
  /** False for constraints added `NOT VALID` and not yet validated. */
  validated: z.boolean(),
});

export const IndexSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
  method: z.literal("btree"),
  /** Partial-index predicate, or null. */
  predicate: z.string().nullable().default(null),
});

export const TableSchema = z.object({
  name: z.string(),
  columns: z.array(ColumnSchema),
  constraints: z.array(ConstraintSchema),
  indexes: z.array(IndexSchema),
});

export const SchemaIRSchema = z.object({
  version: z.literal(1),
  tables: z.array(TableSchema),
});

export type Column = z.infer<typeof ColumnSchema>;
export type Constraint = z.infer<typeof ConstraintSchema>;
export type Index = z.infer<typeof IndexSchema>;
export type Table = z.infer<typeof TableSchema>;
export type SchemaIR = z.infer<typeof SchemaIRSchema>;

export const EMPTY_IR: SchemaIR = { version: 1, tables: [] };

// ---------------------------------------------------------------- lookups

export function findTable(ir: SchemaIR, name: string): Table | undefined {
  return ir.tables.find((t) => t.name === name);
}

export function findColumn(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => c.name === name);
}

/**
 * Physical display / projection order. The IR itself is name-sorted so diffs
 * ignore column reshuffles; views and the data browser still follow `ordinal`.
 */
export function columnsInPhysicalOrder(table: Table): Column[] {
  return [...table.columns].sort((a, b) => a.ordinal - b.ordinal || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Sort every collection by name. Applied after introspection and after any IR
 * mutation, so the canonical form is reachable from an arbitrarily ordered input.
 */
export function sortIR(ir: SchemaIR): SchemaIR {
  const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    version: 1,
    tables: [...ir.tables]
      .sort(byName)
      .map((t) => ({
        name: t.name,
        columns: [...t.columns].sort(byName),
        constraints: [...t.constraints].sort(byName),
        indexes: [...t.indexes].sort(byName),
      })),
  };
}

/** Structural deep clone, safe to mutate. */
export function cloneIR(ir: SchemaIR): SchemaIR {
  return structuredClone(ir);
}
