import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "../src/db.js";
import { buildApp } from "../src/index.js";
import { resolveDemoSeedCommit, SEED_TABLES } from "../src/vcs/commits.js";

let app: FastifyInstance;

describe("demo reset", () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("targets the fullest seeded snapshot, not the two-table root commit", async () => {
    const seedId = await resolveDemoSeedCommit(sql);
    const [seed] = await sql<{ n: number }[]>`
      SELECT jsonb_array_length(ir->'tables') AS n FROM gitdb.commits WHERE id = ${seedId}`;
    const [root] = await sql<{ id: string; n: number }[]>`
      SELECT id, jsonb_array_length(ir->'tables') AS n
        FROM gitdb.commits
       WHERE parent_id IS NULL AND branch = 'main'
       ORDER BY created_at LIMIT 1`;
    expect(seed?.n).toBeGreaterThanOrEqual(root?.n ?? 0);
    if (root && root.n < SEED_TABLES.length) expect(seedId).not.toBe(root.id);
  });

  it("POST /api/demo/reset keeps seeded tables", async () => {
    const before = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relkind = 'r'`;
    const names = before.map((row) => row.relname).sort();
    const res = await app.inject({ method: "POST", url: "/api/demo/reset" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("reset");
    const after = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relkind = 'r'`;
    expect(after.map((row) => row.relname).sort()).toEqual(names);
    const [main] = await sql<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    expect(main?.head_commit).toBe(body.commit);
  });
});
