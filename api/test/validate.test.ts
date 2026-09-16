import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { validateOps } from "../src/engine/validate.js";
import type { SchemaOp } from "../src/diff/diff.js";

const table = "gitdb_validate_probe";

beforeAll(async () => {
  await sql.unsafe(`DROP TABLE IF EXISTS main.${table}`);
  await sql.unsafe(`
    CREATE TABLE main.${table} (
      id int PRIMARY KEY,
      memo text,
      email text,
      amount text
    )`);
  await sql.unsafe(`
    INSERT INTO main.${table} (id, memo, email, amount) VALUES
      (1, NULL, 'a@x', '10'),
      (2, 'ok', 'a@x', 'nope'),
      (3, 'ok', 'b@x', '20')`);
});

afterAll(async () => {
  await sql.unsafe(`DROP TABLE IF EXISTS main.${table}`);
});

describe("validateOps", () => {
  it("set_nullable false counts NULL rows", async () => {
    const op: SchemaOp = { kind: "set_nullable", table, column: "memo", nullable: false };
    const findings = await validateOps(sql, [op]);
    expect(findings[0]).toMatchObject({ blocked: true, count: 1 });
    expect(findings[0]!.message).toMatch(/blocked: 1 rows violate this/);
  });

  it("retype shows uncastable sample rows", async () => {
    const op: SchemaOp = {
      kind: "retype_column",
      table,
      column: "amount",
      from: "pg_catalog.text",
      to: "pg_catalog.int4",
    };
    const findings = await validateOps(sql, [op]);
    const probe = findings.find((f) => f.blocked);
    expect(probe?.samples).toEqual(expect.arrayContaining([expect.objectContaining({ value: "nope" })]));
    expect(findings.some((f) => f.message.includes("backfill"))).toBe(true);
  });

  it("unique constraint finds duplicate keys and ignores NULL", async () => {
    await sql.unsafe(`INSERT INTO main.${table} (id, memo, email, amount) VALUES (4, 'ok', NULL, '1'), (5, 'ok', NULL, '2')`);
    const op: SchemaOp = {
      kind: "add_constraint",
      table,
      constraint: {
        name: "email_uq",
        kind: "unique",
        columns: ["email"],
        expression: null,
        references: null,
        validated: false,
      },
    };
    const findings = await validateOps(sql, [op]);
    expect(findings[0]).toMatchObject({ blocked: true, count: 1 });
    expect(findings[0]!.message).toMatch(/duplicate keys/);
    expect(findings[0]!.samples?.some((row) => row.email == null)).toBe(false);
  });

  it("check constraint counts violations", async () => {
    const op: SchemaOp = {
      kind: "add_constraint",
      table,
      constraint: {
        name: "amount_num",
        kind: "check",
        columns: ["amount"],
        expression: "amount ~ '^[0-9]+$'",
        references: null,
        validated: false,
      },
    };
    const findings = await validateOps(sql, [op]);
    expect(findings[0]?.blocked).toBe(true);
    expect(findings[0]?.count).toBeGreaterThan(0);
  });
});
