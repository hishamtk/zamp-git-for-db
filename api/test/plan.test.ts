import { describe, expect, it } from "vitest";
import { compilePlan } from "../src/engine/plan.js";
import type { SchemaOp } from "../src/diff/diff.js";
import type { Column, SchemaIR, Table } from "../src/ir/types.js";

function column(name: string, overrides: Partial<Column> = {}): Column {
  return {
    name,
    physicalName: name,
    type: "pg_catalog.int8",
    nullable: false,
    default: null,
    ordinal: 1,
    ...overrides,
    name: overrides.name ?? name,
  };
}

const txns: Table = {
  name: "txns",
  columns: [column("id"), column("amount_cents"), column("memo", { type: "pg_catalog.text", nullable: true })],
  constraints: [
    {
      name: "txns_pkey",
      kind: "primary",
      columns: ["id"],
      expression: null,
      references: null,
      validated: true,
    },
  ],
  indexes: [],
};

const from: SchemaIR = { version: 1, tables: [txns] };
const ctx = { mergeId: 1, from };

describe("compilePlan", () => {
  it("SAFE add_column is a single ddl step", () => {
    const op: SchemaOp = {
      kind: "add_column",
      table: "txns",
      column: column("flag", { type: "pg_catalog.bool", nullable: true }),
    };
    const steps = compilePlan([op], ctx);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "ddl", risk: "SAFE" });
    expect(steps[0]!.sql).toContain("ADD COLUMN");
    expect(steps[0]!.sql).toContain("flag");
  });

  it("binary-coercible retype is a single ALTER TYPE", () => {
    const op: SchemaOp = {
      kind: "retype_column",
      table: "txns",
      column: "memo",
      from: "pg_catalog.varchar(20)",
      to: "pg_catalog.text",
    };
    const steps = compilePlan([op], ctx);
    expect(steps.map((s) => s.kind)).toEqual(["ddl"]);
    expect(steps[0]!.sql).toMatch(/TYPE pg_catalog\.text/);
  });

  it("REWRITE retype expands to expand → sync → backfill → validate path → cutover → contract", () => {
    const op: SchemaOp = {
      kind: "retype_column",
      table: "txns",
      column: "amount_cents",
      from: "pg_catalog.int8",
      to: "pg_catalog.numeric(20,2)",
      using: `"amount_cents" / 100.0`,
    };
    const kinds = compilePlan([op], ctx).map((s) => s.kind);
    expect(kinds[0]).toBe("expand");
    expect(kinds[1]).toBe("sync");
    expect(kinds[2]).toBe("backfill");
    expect(kinds.at(-2)).toBe("cutover");
    expect(kinds.at(-1)).toBe("contract");
    const contract = compilePlan([op], ctx).at(-1)!;
    expect(contract.manual).toBe(true);
    expect(kinds).toContain("validate");
  });

  it("SET NOT NULL uses NOT VALID → VALIDATE → SET NOT NULL, not a helper column", () => {
    const op: SchemaOp = { kind: "set_nullable", table: "txns", column: "memo", nullable: false };
    const steps = compilePlan([op], ctx);
    expect(steps.map((s) => s.kind)).toEqual(["ddl", "validate", "ddl", "ddl"]);
    expect(steps[0]!.sql).toMatch(/NOT VALID/);
    expect(steps[1]!.sql).toMatch(/VALIDATE CONSTRAINT/);
    expect(steps[2]!.sql).toMatch(/SET NOT NULL/);
    expect(steps.some((s) => s.kind === "expand")).toBe(false);
  });

  it("volatile default add_column is a rewrite expansion", () => {
    const op: SchemaOp = {
      kind: "add_column",
      table: "txns",
      column: column("created_at", { type: "pg_catalog.timestamptz", default: "now()" }),
    };
    const kinds = compilePlan([op], ctx).map((s) => s.kind);
    expect(kinds.slice(0, 3)).toEqual(["expand", "sync", "backfill"]);
  });

  it("add_index is CREATE INDEX CONCURRENTLY", () => {
    const op: SchemaOp = {
      kind: "add_index",
      table: "txns",
      index: { name: "txns_memo_idx", columns: ["memo"], unique: false, method: "btree", predicate: null },
    };
    const steps = compilePlan([op], ctx);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("index_concurrent");
    expect(steps[0]!.sql).toMatch(/CREATE INDEX CONCURRENTLY/);
  });

  it("check constraint is NOT VALID then VALIDATE", () => {
    const op: SchemaOp = {
      kind: "add_constraint",
      table: "txns",
      constraint: {
        name: "positive",
        kind: "check",
        columns: ["amount_cents"],
        expression: "amount_cents > 0",
        references: null,
        validated: false,
      },
    };
    const steps = compilePlan([op], ctx);
    expect(steps.map((s) => s.kind)).toEqual(["ddl", "validate"]);
    expect(steps[0]!.sql).toMatch(/NOT VALID/);
  });
});
