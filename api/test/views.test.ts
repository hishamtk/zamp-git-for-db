import { describe, expect, it } from "vitest";
import { createTableSQL, selectListFor } from "../src/engine/views.js";
import type { Column, Table } from "../src/ir/types.js";

function column(name: string, ordinal: number): Column {
  return {
    name,
    physicalName: name,
    type: "pg_catalog.text",
    nullable: true,
    default: null,
    ordinal,
  };
}

function table(columns: Column[]): Table {
  return { name: "accounts", columns, constraints: [], indexes: [] };
}

describe("branch view projection", () => {
  it("emits columns in physical ordinal order, not IR name order", () => {
    const accounts = table([
      column("country", 4),
      column("created_at", 5),
      column("email", 3),
      column("id", 1),
      column("name", 2),
    ]);
    expect(selectListFor(accounts, accounts)).toBe('"id", "name", "email", "country", "created_at"');
    expect(createTableSQL("br_x", accounts)).toContain(
      '"id" pg_catalog.text, "name" pg_catalog.text, "email" pg_catalog.text, "country" pg_catalog.text, "created_at" pg_catalog.text',
    );
  });
});
