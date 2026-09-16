import { describe, expect, it } from "vitest";
import { merge } from "../src/vcs/merge.js";
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

function table(name: string, columns: Column[], extra: Partial<Table> = {}): Table {
  return { name, columns, constraints: [], indexes: [], ...extra, name };
}

function ir(...tables: Table[]): SchemaIR {
  return { version: 1, tables };
}

const baseTxns = table("txns", [
  column("id", { nullable: false }),
  column("amount_cents", { nullable: false }),
  column("memo", { type: "pg_catalog.text" }),
]);

const accounts = table("accounts", [column("id", { nullable: false }), column("email", { type: "pg_catalog.text" })]);

describe("merge", () => {
  it("both sides retyping the same column differently → conflict", () => {
    const base = ir(baseTxns);
    const ours = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false, type: "pg_catalog.numeric(20,2)" }),
        column("memo", { type: "pg_catalog.text" }),
      ]),
    );
    const theirs = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false, type: "pg_catalog.text" }),
        column("memo", { type: "pg_catalog.text" }),
      ]),
    );
    const result = merge(base, ours, theirs);
    expect(result).toMatchObject({
      conflicts: [
        expect.objectContaining({
          path: "txns.amount_cents",
          reason: expect.stringMatching(/both sides changed/i),
        }),
      ],
    });
    if ("conflicts" in result) {
      expect(result.conflicts).toHaveLength(1);
    }
  });

  it("disjoint branches merge clean", () => {
    const base = ir(baseTxns, accounts);
    const ours = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false }),
        column("memo", { type: "pg_catalog.text" }),
        column("status", { type: "pg_catalog.text" }),
      ]),
      accounts,
    );
    const theirs = ir(
      baseTxns,
      table("accounts", [
        column("id", { nullable: false }),
        column("email", { type: "pg_catalog.text" }),
        column("country", { type: "pg_catalog.bpchar(2)", nullable: false }),
      ]),
    );
    const result = merge(base, ours, theirs);
    expect("ops" in result).toBe(true);
    if ("ops" in result) {
      expect(result.ops.map((o) => o.kind).sort()).toEqual(["add_column"]);
      expect(result.ops[0]).toMatchObject({
        kind: "add_column",
        table: "accounts",
        column: expect.objectContaining({ name: "country" }),
      });
    }
  });

  it("main advancing on an untouched table does not conflict", () => {
    const base = ir(baseTxns, accounts);
    const ours = ir(
      baseTxns,
      table("accounts", [
        column("id", { nullable: false }),
        column("email", { type: "pg_catalog.text" }),
        column("name", { type: "pg_catalog.text", nullable: false }),
      ]),
    );
    const theirs = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false }),
        column("memo", { type: "pg_catalog.text" }),
        column("settled_at", { type: "pg_catalog.timestamptz" }),
      ]),
      accounts,
    );
    const result = merge(base, ours, theirs);
    expect("ops" in result).toBe(true);
    if ("ops" in result) {
      expect(result.ops).toEqual([
        expect.objectContaining({ kind: "add_column", table: "txns", column: expect.objectContaining({ name: "settled_at" }) }),
      ]);
    }
  });

  it("identical changes on both sides converge to a no-op", () => {
    const next = table("txns", [
      column("id", { nullable: false }),
      column("amount_cents", { nullable: false }),
      column("memo", { type: "pg_catalog.text" }),
      column("flag", { type: "pg_catalog.bool" }),
    ]);
    const result = merge(ir(baseTxns), ir(next), ir(next));
    expect(result).toEqual({ ops: [] });
  });

  it("ours-only change is kept (ops against ours are empty for that path)", () => {
    const ours = ir(
      table("txns", [
        column("id", { nullable: false }),
        column("amount_cents", { nullable: false }),
        column("memo", { type: "pg_catalog.text" }),
        column("ours_only", { type: "pg_catalog.text" }),
      ]),
    );
    const result = merge(ir(baseTxns), ours, ir(baseTxns));
    expect(result).toEqual({ ops: [] });
  });
});
