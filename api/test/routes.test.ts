import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { buildApp } from "../src/index.js";
import type { FastifyInstance } from "fastify";

const branch = "task18-route";
let app: FastifyInstance;

describe("Task 18 API routes", () => {
  beforeAll(async () => {
    app = await buildApp();
    await sql`DELETE FROM gitdb.merges WHERE source_branch = ${branch}`;
    const [existing] = await sql`SELECT name FROM gitdb.branches WHERE name = ${branch}`;
    if (existing) await app.inject({ method: "DELETE", url: `/api/branches/${branch}` });
  });

  afterAll(async () => {
    await sql`DELETE FROM gitdb.merges WHERE source_branch = ${branch}`;
    const [existing] = await sql`SELECT name FROM gitdb.branches WHERE name = ${branch}`;
    if (existing) await app.inject({ method: "DELETE", url: `/api/branches/${branch}` });
    await app.close();
  });

  it("exposes health and rejects invalid authoring", async () => {
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/api/branches",
      payload: { name: "BAD!", from: "main" },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url: "/api/validate",
      payload: { branch: "main" },
    })).statusCode).toBe(200);
  });

  it("supports branch DDL, working-tree diff, commit, and merge planning", async () => {
    expect((await app.inject({
      method: "POST",
      url: "/api/branches",
      payload: { name: branch, from: "main" },
    })).statusCode).toBe(201);

    const dml = await app.inject({
      method: "POST",
      url: `/api/branches/${branch}/ddl`,
      payload: { sql: "UPDATE accounts SET name = 'nope'" },
    });
    expect(dml.statusCode).toBe(400);
    expect(dml.json().message).toContain("only schema DDL");

    const ddl = await app.inject({
      method: "POST",
      url: `/api/branches/${branch}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN route_note text" },
    });
    expect(ddl.statusCode).toBe(200);
    expect(ddl.json().ops[0]).toMatchObject({ kind: "add_column", table: "accounts" });

    const schema = await app.inject({ method: "GET", url: `/api/branches/${branch}/schema` });
    expect(schema.json().ir.tables.find((t: { name: string }) => t.name === "accounts").columns)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "route_note" })]));

    const diff = await app.inject({ method: "GET", url: `/api/diff?from=main&to=${branch}` });
    expect(diff.json().ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "add_column", risk: "SAFE" }),
    ]));

    const dirtyMerge = await app.inject({
      method: "POST",
      url: "/api/merges",
      payload: { source: branch, target: "main" },
    });
    expect(dirtyMerge.statusCode).toBe(409);
    expect(dirtyMerge.json()).toMatchObject({ state: "dirty" });

    const commit = await app.inject({
      method: "POST",
      url: `/api/branches/${branch}/commit`,
      payload: { message: "add route note" },
    });
    expect(commit.statusCode).toBe(200);

    const planned = await app.inject({
      method: "POST",
      url: "/api/merges",
      payload: { source: branch, target: "main" },
    });
    expect(planned.statusCode).toBe(201);
    expect(planned.json()).toMatchObject({ state: "planned" });
    expect(planned.json().plan.length).toBeGreaterThan(0);

    const [main] = await sql<{ head_commit: string; base_commit: string }[]>`
      SELECT head_commit, base_commit FROM gitdb.branches WHERE name = 'main'`;
    const [noop] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
      ) VALUES (
        ${branch}, ${main!.head_commit}, ${main!.head_commit}, ${main!.base_commit},
        NULL, '[]'::jsonb, 'planned'
      ) RETURNING id::text`;
    const id = Number(noop!.id);
    const applied = await app.inject({ method: "POST", url: `/api/merges/${id}/apply` });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ id, state: "merged" });

    const mergeStatus = await app.inject({ method: "GET", url: `/api/merges/${id}` });
    expect(mergeStatus.json()).toMatchObject({ id, state: "merged", steps: [] });

    const contracted = await app.inject({ method: "POST", url: `/api/merges/${id}/contract` });
    expect(contracted.statusCode).toBe(200);
    expect(contracted.json()).toMatchObject({ id, state: "contracted" });

    const refused = await app.inject({ method: "POST", url: `/api/merges/${id}/revert` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ state: "revert_refused" });

    const [running] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
      ) VALUES (
        ${branch}, ${main!.head_commit}, ${main!.head_commit}, ${main!.base_commit},
        NULL, '[]'::jsonb, 'running'
      ) RETURNING id::text`;
    const [second] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, result_ir, plan, state
      ) VALUES (
        ${branch}, ${main!.head_commit}, ${main!.head_commit}, ${main!.base_commit},
        NULL, '[]'::jsonb, 'planned'
      ) RETURNING id::text`;
    const busy = await app.inject({ method: "POST", url: `/api/merges/${second!.id}/apply` });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ state: "merge_in_progress", mergeId: Number(running!.id) });
  });
});
