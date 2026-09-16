import { describe, expect, it } from "vitest";
import { diff } from "../src/diff/diff.js";
import { detectRenames, diffWithSuggestions } from "../src/diff/rename.js";
import type { Column, SchemaIR, Table } from "../src/ir/types.js";

function column(name: string, overrides: Partial<Column> = {}): Column {
  return {
    name,
    physicalName: name,
    type: "pg_catalog.int8",
    nullable: true,
    default: null,
    ordinal: 1,
    ...overrides,
    name: overrides.name ?? name,
  };
}

function table(name: string, columns: Column[]): Table {
  return { name, columns, constraints: [], indexes: [] };
}

function ir(...tables: Table[]): SchemaIR {
  return { version: 1, tables };
}

describe("detectRenames", () => {
  it("suggests amount_cents → amount (shared prefix ≥ 4)", () => {
    const from = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false }),
      ]),
    );
    const to = ir(
      table("txns", [column("id", { nullable: false }), column("amount", { nullable: false })]),
    );
    const ops = diff(from, to);
    expect(ops.map((o) => o.kind).sort()).toEqual(["add_column", "drop_column"]);
    expect(detectRenames(from, ops)).toEqual([
      {
        table: "txns",
        from: "amount_cents",
        to: "amount",
        reason: "shared prefix 'amount'",
      },
    ]);
  });

  it("does not suggest memo dropped + unrelated notes added", () => {
    const from = ir(
      table("txns", [column("id", { nullable: false }), column("memo", { type: "pg_catalog.text" })]),
    );
    const to = ir(
      table("txns", [column("id", { nullable: false }), column("notes", { type: "pg_catalog.text" })]),
    );
    const ops = diff(from, to);
    expect(detectRenames(from, ops)).toEqual([]);
  });

  it("requires identical type and nullability", () => {
    const from = ir(table("t", [column("name", { type: "pg_catalog.text", nullable: true })]));
    const to = ir(table("t", [column("nama", { type: "pg_catalog.int4", nullable: true })]));
    expect(detectRenames(from, diff(from, to))).toEqual([]);
  });

  it("Levenshtein ≤ 3 is enough (email → emails)", () => {
    const from = ir(table("t", [column("email", { type: "pg_catalog.text" })]));
    const to = ir(table("t", [column("emails", { type: "pg_catalog.text" })]));
    expect(detectRenames(from, diff(from, to))).toEqual([
      { table: "t", from: "email", to: "emails", reason: "Levenshtein 1" },
    ]);
  });

  it("does not rewrite ops — suggestions are separate", () => {
    const from = ir(table("t", [column("amount_cents")]));
    const to = ir(table("t", [column("amount")]));
    const { ops, renameSuggestions } = diffWithSuggestions(from, to);
    expect(ops.some((o) => o.kind === "rename_column")).toBe(false);
    expect(renameSuggestions).toHaveLength(1);
  });
});
