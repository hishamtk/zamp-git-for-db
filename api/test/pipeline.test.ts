import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackfill } from "../src/engine/backfill.js";
import { compilePlan } from "../src/engine/plan.js";
import { persistPlan, runMerge } from "../src/engine/runner.js";
import { introspect } from "../src/ir/introspect.js";
import { bootstrap } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);
const mergeIds: number[] = [];

async function newMerge(): Promise<number> {
  const [main] = await db<{ head_commit: string }[]>`
    SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
  const [row] = await db<{ id: string }[]>`
    INSERT INTO gitdb.merges (
      source_branch, source_commit, target_commit, base_commit, plan, state
    ) VALUES (
      'pipeline-test', ${main!.head_commit}, ${main!.head_commit}, ${main!.head_commit},
      '[]'::jsonb, 'planned'
    ) RETURNING id::text`;
  const id = Number(row!.id);
  mergeIds.push(id);
  return id;
}

describe("expand → backfill → cutover pipeline", () => {
  beforeAll(async () => {
    await bootstrap(db);
    await db`DROP TABLE IF EXISTS main.gitdb_pipeline_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_pipeline_probe (
        id bigint PRIMARY KEY,
        amount_cents bigint NOT NULL
      )`;
    await db`
      INSERT INTO main.gitdb_pipeline_probe (id, amount_cents)
      SELECT n, n * 100 FROM generate_series(1::bigint, 40::bigint) n`;
  });

  afterAll(async () => {
    if (mergeIds.length) await db`DELETE FROM gitdb.merges WHERE id = ANY(${mergeIds})`;
    await db`DROP TABLE IF EXISTS main.gitdb_pipeline_probe CASCADE`;
    await db.end({ timeout: 5 });
  });

  it("preserves every row through expand, sync, backfill, and cutover", async () => {
    const mergeId = await newMerge();
    const from = (await introspect(db, "main")).ir;
    const plan = compilePlan(
      [{
        kind: "retype_column",
        table: "gitdb_pipeline_probe",
        column: "amount_cents",
        from: "pg_catalog.int8",
        to: "pg_catalog.numeric",
      }],
      { mergeId, from },
    );
    expect(plan.map((step) => step.kind).slice(0, 3)).toEqual(["expand", "sync", "backfill"]);
    expect(plan.at(-1)).toMatchObject({ kind: "contract", manual: true });

    await persistPlan(db, mergeId, plan);
    await runMerge(mergeId, { sql: db, worker: db, plan });

    const rows = await db<{ id: string; amount_cents: string }[]>`
      SELECT id::text, amount_cents::text
        FROM main.gitdb_pipeline_probe
       ORDER BY id`;
    expect(rows).toHaveLength(40);
    expect(rows.every((row) => Number(row.amount_cents) === Number(row.id) * 100)).toBe(true);

    const [merge] = await db<{ state: string; contracted_at: Date | null }[]>`
      SELECT state, contracted_at FROM gitdb.merges WHERE id = ${mergeId}`;
    expect(merge).toMatchObject({ state: "merged", contracted_at: null });
    const steps = await db<{ kind: string; state: string }[]>`
      SELECT kind, state FROM gitdb.merge_steps WHERE merge_id = ${mergeId} ORDER BY seq`;
    expect(steps.find((step) => step.kind === "contract")?.state).toBe("skipped");
    expect(steps.filter((step) => step.kind !== "contract").every((step) => step.state === "done")).toBe(true);
  });

  it("resumes a backfill from the persisted cursor after a mid-sweep kill", async () => {
    await db`DROP TABLE IF EXISTS main.gitdb_pipeline_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_pipeline_probe (
        id bigint PRIMARY KEY,
        amount_cents bigint NOT NULL,
        amount_cents__new numeric
      )`;
    await db`
      INSERT INTO main.gitdb_pipeline_probe (id, amount_cents)
      SELECT n, n * 100 FROM generate_series(1::bigint, 40::bigint) n`;

    const mergeId = await newMerge();
    const step = {
      seq: 0,
      kind: "backfill" as const,
      sql: "",
      risk: "REWRITE" as const,
      table: "gitdb_pipeline_probe",
      pk: "id",
      column: "amount_cents",
      shadow: "amount_cents__new",
      expression: `"amount_cents"::numeric`,
    };
    await persistPlan(db, mergeId, [step]);
    await db`
      UPDATE gitdb.merge_steps SET state = 'running'
       WHERE merge_id = ${mergeId} AND seq = 0`;

    await expect(runBackfill(mergeId, step, {
      sql: db,
      initialBatchSize: 10,
      afterBatch: async ({ cursor }) => {
        if (cursor <= 10) throw new Error("killed mid-backfill");
      },
    })).rejects.toThrow("killed mid-backfill");

    const [partial] = await db<{ cursor: string; filled: string; empty: string }[]>`
      SELECT cursor::text,
             (SELECT count(*)::text FROM main.gitdb_pipeline_probe WHERE amount_cents__new IS NOT NULL) AS filled,
             (SELECT count(*)::text FROM main.gitdb_pipeline_probe WHERE amount_cents__new IS NULL) AS empty
        FROM gitdb.merge_steps WHERE merge_id = ${mergeId} AND seq = 0`;
    expect(Number(partial!.cursor)).toBeGreaterThan(0);
    expect(Number(partial!.filled)).toBeGreaterThan(0);
    expect(Number(partial!.empty)).toBeGreaterThan(0);

    await runMerge(mergeId, { sql: db, worker: db, plan: [step] });

    const [done] = await db<{ empty: string; state: string }[]>`
      SELECT
        (SELECT count(*)::text FROM main.gitdb_pipeline_probe WHERE amount_cents__new IS NULL) AS empty,
        (SELECT state FROM gitdb.merge_steps WHERE merge_id = ${mergeId} AND seq = 0) AS state`;
    expect(done).toMatchObject({ empty: "0", state: "done" });
  });
});
