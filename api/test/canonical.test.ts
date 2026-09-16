import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJSON, hashIR, irEquals } from "../src/ir/canonical.js";
import { SchemaIRSchema, sortIR, type Column, type SchemaIR, type Table } from "../src/ir/types.js";

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

function table(name: string, overrides: Partial<Table> = {}): Table {
  return {
    name,
    columns: [column("id", { nullable: false })],
    constraints: [{
      name: `${name}_pkey`,
      kind: "primary",
      columns: ["id"],
      expression: null,
      references: null,
      validated: true,
    }],
    indexes: [],
    ...overrides,
    name,
  };
}

function ir(...tables: Table[]): SchemaIR {
  return { version: 1, tables };
}

const fixture: SchemaIR = ir(
  table("txns", {
    columns: [
      column("id", { nullable: false, ordinal: 1 }),
      column("amount_cents", { nullable: false, ordinal: 2 }),
      column("memo", { type: "pg_catalog.text", ordinal: 3 }),
    ],
    indexes: [{
      name: "txns_memo_idx",
      columns: ["memo"],
      unique: false,
      method: "btree",
      predicate: null,
    }],
  }),
  table("accounts"),
);

describe("canonical JSON + hashing", () => {
  it("Zod schemas round-trip a hand-written fixture", () => {
    expect(SchemaIRSchema.parse(fixture)).toEqual(fixture);
  });

  it("emits compact JSON with a fixed key order", () => {
    const json = canonicalJSON(fixture);
    expect(json.includes(" ")).toBe(false);
    expect(json.includes("\n")).toBe(false);
    expect(json).toContain('"tables":[');
    expect(json).toContain('"version":1');
    expect(json.indexOf('"name":"accounts"')).toBeLessThan(json.indexOf('"name":"txns"'));
    expect(JSON.parse(json)).toMatchObject({ version: 1 });
  });

  it("omits ordinal, so column order does not change the hash", () => {
    const shuffled = structuredClone(fixture);
    const txns = shuffled.tables.find((candidate) => candidate.name === "txns")!;
    txns.columns.reverse();
    txns.columns[0]!.ordinal = 99;
    expect(canonicalJSON(shuffled)).toBe(canonicalJSON(fixture));
    expect(hashIR(shuffled)).toBe(hashIR(fixture));
    expect(canonicalJSON(fixture)).not.toContain("ordinal");
  });

  it("is stable across repeated sortIR / process-local calls", () => {
    const once = hashIR(fixture);
    const twice = hashIR(sortIR(sortIR(structuredClone(fixture))));
    expect(twice).toBe(once);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
    expect(once).toBe(createHash("sha256").update(canonicalJSON(fixture), "utf8").digest("hex"));
  });

  it("changes when a semantic field changes, including null vs absent defaults", () => {
    const retyped = structuredClone(fixture);
    retyped.tables.find((candidate) => candidate.name === "txns")!.columns[1]!.type = "pg_catalog.numeric";
    expect(hashIR(retyped)).not.toBe(hashIR(fixture));
    expect(irEquals(retyped, fixture)).toBe(false);

    const withDefault = structuredClone(fixture);
    withDefault.tables.find((candidate) => candidate.name === "txns")!.columns[1]!.default = "0";
    expect(hashIR(withDefault)).not.toBe(hashIR(fixture));
  });

  it("treats missing optional constraint/index fields as null, not distinct", () => {
    const implicit: SchemaIR = {
      version: 1,
      tables: [{
        name: "t",
        columns: [column("id", { nullable: false })],
        constraints: [{
          name: "t_pkey",
          kind: "primary",
          columns: ["id"],
          validated: true,
        } as never],
        indexes: [{
          name: "t_id_idx",
          columns: ["id"],
          unique: false,
          method: "btree",
        } as never],
      }],
    };
    const explicit = ir(table("t", {
      indexes: [{
        name: "t_id_idx",
        columns: ["id"],
        unique: false,
        method: "btree",
        predicate: null,
      }],
    }));
    expect(hashIR(implicit)).toBe(hashIR(explicit));
  });
});
