import { describe, expect, it } from "vitest";
import { classify } from "../src/diff/classify.js";
import type { SchemaOp } from "../src/diff/diff.js";
import type { Column, Constraint, Index, Table } from "../src/ir/types.js";

function col(overrides: Partial<Column> & { name: string }): Column {
  return {
    physicalName: overrides.name,
    type: "pg_catalog.text",
    nullable: true,
    default: null,
    ordinal: 1,
    ...overrides,
  };
}

function addColumn(column: Column): SchemaOp {
  return { kind: "add_column", table: "txns", column };
}

describe("classify", () => {
  it("add_column nullable, no default → SAFE", () => {
    expect(classify(addColumn(col({ name: "memo" })))).toBe("SAFE");
  });

  it("add_column with constant default → SAFE", () => {
    expect(classify(addColumn(col({ name: "flag", default: "'x'::text" })))).toBe("SAFE");
    expect(classify(addColumn(col({ name: "n", type: "pg_catalog.int4", default: "0" })))).toBe("SAFE");
    expect(classify(addColumn(col({ name: "b", type: "pg_catalog.bool", default: "true" })))).toBe("SAFE");
  });

  it("add_column with volatile default → REWRITE", () => {
    expect(classify(addColumn(col({ name: "created", default: "now()" })))).toBe("REWRITE");
    expect(classify(addColumn(col({ name: "id", default: "gen_random_uuid()" })))).toBe("REWRITE");
    expect(classify(addColumn(col({ name: "r", type: "pg_catalog.float8", default: "random()" })))).toBe(
      "REWRITE",
    );
    expect(classify(addColumn(col({ name: "ts", default: "CURRENT_TIMESTAMP" })))).toBe("REWRITE");
  });

  it("unknown functions in a default are treated as volatile", () => {
    expect(classify(addColumn(col({ name: "x", default: "my_custom_fn()" })))).toBe("REWRITE");
  });

  it("drop_column → SAFE", () => {
    expect(classify({ kind: "drop_column", table: "txns", column: "memo" })).toBe("SAFE");
  });

  it("rename_column → SAFE", () => {
    expect(classify({ kind: "rename_column", table: "txns", from: "amount_cents", to: "amount" })).toBe(
      "SAFE",
    );
  });

  it("retype_column binary-coercible → SAFE", () => {
    expect(
      classify({
        kind: "retype_column",
        table: "t",
        column: "n",
        from: "pg_catalog.varchar(20)",
        to: "pg_catalog.text",
      }),
    ).toBe("SAFE");
    expect(
      classify({
        kind: "retype_column",
        table: "t",
        column: "n",
        from: "pg_catalog.varchar(20)",
        to: "pg_catalog.varchar(40)",
      }),
    ).toBe("SAFE");
  });

  it("retype_column otherwise → REWRITE", () => {
    expect(
      classify({
        kind: "retype_column",
        table: "t",
        column: "n",
        from: "pg_catalog.int8",
        to: "pg_catalog.numeric(20,2)",
      }),
    ).toBe("REWRITE");
    expect(
      classify({
        kind: "retype_column",
        table: "t",
        column: "n",
        from: "pg_catalog.varchar(40)",
        to: "pg_catalog.varchar(20)",
      }),
    ).toBe("REWRITE");
  });

  it("set_nullable true → SAFE", () => {
    expect(classify({ kind: "set_nullable", table: "t", column: "memo", nullable: true })).toBe("SAFE");
  });

  it("set_nullable false → LOCKING", () => {
    expect(classify({ kind: "set_nullable", table: "t", column: "memo", nullable: false })).toBe("LOCKING");
  });

  it("add_index → LOCKING", () => {
    const index: Index = {
      name: "txns_memo_idx",
      columns: ["memo"],
      unique: false,
      method: "btree",
      predicate: null,
    };
    expect(classify({ kind: "add_index", table: "txns", index })).toBe("LOCKING");
  });

  it("add_constraint check / foreign → LOCKING", () => {
    const check: Constraint = {
      name: "c",
      kind: "check",
      columns: ["n"],
      expression: "n > 0",
      references: null,
      validated: false,
    };
    const fk: Constraint = {
      name: "fk",
      kind: "foreign",
      columns: ["id"],
      expression: null,
      references: { table: "accounts", columns: ["id"] },
      validated: false,
    };
    expect(classify({ kind: "add_constraint", table: "t", constraint: check })).toBe("LOCKING");
    expect(classify({ kind: "add_constraint", table: "t", constraint: fk })).toBe("LOCKING");
  });

  it("add_constraint unique (and primary) → LOCKING", () => {
    const unique: Constraint = {
      name: "u",
      kind: "unique",
      columns: ["email"],
      expression: null,
      references: null,
      validated: true,
    };
    const primary: Constraint = {
      name: "p",
      kind: "primary",
      columns: ["id"],
      expression: null,
      references: null,
      validated: true,
    };
    expect(classify({ kind: "add_constraint", table: "t", constraint: unique })).toBe("LOCKING");
    expect(classify({ kind: "add_constraint", table: "t", constraint: primary })).toBe("LOCKING");
  });

  it("create_table / drop_table / drop_* → SAFE", () => {
    const table: Table = {
      name: "n",
      columns: [col({ name: "id", nullable: false, type: "pg_catalog.int8" })],
      constraints: [],
      indexes: [],
    };
    expect(classify({ kind: "create_table", table })).toBe("SAFE");
    expect(classify({ kind: "drop_table", table: "n" })).toBe("SAFE");
    expect(classify({ kind: "drop_constraint", table: "t", constraint: "c" })).toBe("SAFE");
    expect(classify({ kind: "drop_index", table: "t", index: "i" })).toBe("SAFE");
  });

  it("set_default is SAFE (metadata)", () => {
    expect(classify({ kind: "set_default", table: "t", column: "memo", default: "'x'" })).toBe("SAFE");
    expect(classify({ kind: "set_default", table: "t", column: "memo", default: null })).toBe("SAFE");
  });
});
