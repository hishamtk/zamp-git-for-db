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

  it("POST /api/demo/reset keeps seeded tables, drops extras, and clears merge history", async () => {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS main.gitdb_reset_probe (id bigint PRIMARY KEY)`);
    const [main] = await sql<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    await sql`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, plan, state
      ) VALUES (
        'reset-history', ${main!.head_commit}, ${main!.head_commit}, ${main!.head_commit},
        '[]'::jsonb, 'merged'
      )`;

    const res = await app.inject({ method: "POST", url: "/api/demo/reset" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("reset");

    const after = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relkind = 'r'`;
    const names = after.map((row) => row.relname);
    for (const table of SEED_TABLES) expect(names).toContain(table);
    expect(names).not.toContain("gitdb_reset_probe");

    const [head] = await sql<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    expect(head?.head_commit).toBe(body.commit);

    const [{ merges }] = await sql<{ merges: string }[]>`SELECT count(*)::text AS merges FROM gitdb.merges`;
    expect(merges).toBe("0");
    const extra = await sql<{ id: string }[]>`
      SELECT id FROM gitdb.commits
       WHERE branch = 'main'
         AND id NOT IN (
           WITH RECURSIVE keep AS (
             SELECT id, parent_id FROM gitdb.commits WHERE id = ${body.commit}
             UNION ALL
             SELECT c.id, c.parent_id FROM gitdb.commits c JOIN keep k ON c.id = k.parent_id
           )
           SELECT id FROM keep
         )`;
    expect(extra).toEqual([]);
  });
});
