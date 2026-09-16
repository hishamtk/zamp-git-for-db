import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIndexConcurrently } from "../src/engine/indexes.js";

const url = process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";
const db = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
const worker = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

describe("concurrent index path", () => {
  beforeAll(async () => {
    await db`DROP TABLE IF EXISTS main.gitdb_index_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_index_probe (
        id bigint PRIMARY KEY,
        value bigint NOT NULL
      )`;
    await db`
      INSERT INTO main.gitdb_index_probe (id, value)
      SELECT n, n % 10 FROM generate_series(1::bigint, 100000::bigint) n`;
  });

  afterAll(async () => {
    await db`DROP TABLE IF EXISTS main.gitdb_index_probe CASCADE`;
    await Promise.all([db.end({ timeout: 5 }), worker.end({ timeout: 5 })]);
  });

  it("builds outside a transaction without blocking an insert", async () => {
    const building = createIndexConcurrently(
      "CREATE INDEX CONCURRENTLY gitdb_index_probe_value_idx ON main.gitdb_index_probe (value)",
      { sql: worker },
    );
    const started = performance.now();
    await db`INSERT INTO main.gitdb_index_probe (id, value) VALUES (100001, 1)`;
    const insertMs = performance.now() - started;
    await building;

    const [index] = await db<{ indisvalid: boolean }[]>`
      SELECT i.indisvalid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.oid = 'main.gitdb_index_probe_value_idx'::regclass`;
    expect(index!.indisvalid).toBe(true);
    expect(insertMs).toBeLessThan(1000);
  });

  it("removes invalid artifacts after a failed concurrent build", async () => {
    await expect(
      createIndexConcurrently(
        "CREATE UNIQUE INDEX CONCURRENTLY gitdb_index_probe_bad_idx ON main.gitdb_index_probe (value)",
        { sql: worker, attempts: 3 },
      ),
    ).rejects.toThrow(/failed after 3 attempts/);
    const [row] = await db<{ exists: boolean }[]>`
      SELECT to_regclass('main.gitdb_index_probe_bad_idx') IS NOT NULL AS exists`;
    expect(row!.exists).toBe(false);
  });
});
