import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MigrationStep } from "../src/engine/plan.js";
import { persistPlan, runMerge } from "../src/engine/runner.js";
import { bootstrap } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);

describe("resumable migration runner", () => {
  beforeAll(async () => {
    await bootstrap(db);
    await db`DROP TABLE IF EXISTS main.gitdb_runner_probe`;
    await db`CREATE TABLE main.gitdb_runner_probe (id bigint PRIMARY KEY)`;
  });

  afterAll(async () => {
    await db`DROP TABLE IF EXISTS main.gitdb_runner_probe`;
    await db.end({ timeout: 5 });
  });

  it("starts at the first non-done step and skips contract", async () => {
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    const [merge] = await db<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, plan, state
      ) VALUES (
        'runner-test', ${main!.head_commit}, ${main!.head_commit}, ${main!.head_commit},
        '[]'::jsonb, 'planned'
      )
      RETURNING id::text`;
    const mergeId = Number(merge!.id);
    const plan: MigrationStep[] = [
      {
        seq: 0,
        kind: "ddl",
        sql: "ALTER TABLE main.gitdb_runner_probe ADD COLUMN value integer",
        risk: "SAFE",
        table: "gitdb_runner_probe",
      },
      {
        seq: 1,
        kind: "ddl",
        sql: "ALTER TABLE main.gitdb_runner_probe ALTER COLUMN value SET DEFAULT 7",
        risk: "SAFE",
        table: "gitdb_runner_probe",
      },
      {
        seq: 2,
        kind: "contract",
        sql: "ALTER TABLE main.gitdb_runner_probe DROP COLUMN value",
        risk: "SAFE",
        manual: true,
        table: "gitdb_runner_probe",
      },
    ];
    await persistPlan(db, mergeId, plan);

    await db.unsafe(plan[0]!.sql);
    await db`
      UPDATE gitdb.merge_steps SET state = 'done'
       WHERE merge_id = ${mergeId} AND seq = 0`;

    await runMerge(mergeId, { sql: db, worker: db });

    const steps = await db<{ state: string }[]>`
      SELECT state FROM gitdb.merge_steps
       WHERE merge_id = ${mergeId} ORDER BY seq`;
    expect(steps.map((step) => step.state)).toEqual(["done", "done", "skipped"]);
    const [row] = await db<{ state: string; contracted_at: Date | null }[]>`
      SELECT state, contracted_at FROM gitdb.merges WHERE id = ${mergeId}`;
    expect(row).toMatchObject({ state: "merged", contracted_at: null });
    const [inserted] = await db<{ value: number }[]>`
      INSERT INTO main.gitdb_runner_probe (id) VALUES (1) RETURNING value`;
    expect(inserted!.value).toBe(7);

    await db`DELETE FROM gitdb.merges WHERE id = ${mergeId}`;
    await db`ALTER TABLE main.gitdb_runner_probe DROP COLUMN value`;
  });
});
