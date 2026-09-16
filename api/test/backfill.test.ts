import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBackfill } from "../src/engine/backfill.js";
import { guardedDDL } from "../src/engine/guarded.js";
import type { MigrationStep } from "../src/engine/plan.js";
import { bootstrap } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);
let mergeId: number;

const step = (seq: number): MigrationStep => ({
  seq,
  kind: "backfill",
  sql: "",
  risk: "REWRITE",
  table: "gitdb_backfill_probe",
  pk: "id",
  column: "old_value",
  shadow: "new_value",
  expression: '"old_value" * 2',
});

async function addStep(seq: number): Promise<void> {
  await db`
    INSERT INTO gitdb.merge_steps (merge_id, seq, kind, sql, state)
    VALUES (${mergeId}, ${seq}, 'backfill', '', 'running')`;
}

describe("backfill sync-trigger race", () => {
  beforeAll(async () => {
    await bootstrap(db);
    await db`DROP TABLE IF EXISTS main.gitdb_backfill_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_backfill_probe (
        id bigint PRIMARY KEY,
        old_value bigint NOT NULL,
        new_value bigint
      )`;
    await db`
      INSERT INTO main.gitdb_backfill_probe (id, old_value)
      SELECT n, n FROM generate_series(1::bigint, 100::bigint) n`;
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    const [merge] = await db<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, plan, state
      ) VALUES (
        'backfill-test', ${main!.head_commit}, ${main!.head_commit}, ${main!.head_commit},
        '[]'::jsonb, 'running'
      ) RETURNING id::text`;
    mergeId = Number(merge!.id);
  });

  afterAll(async () => {
    await db`DELETE FROM gitdb.merges WHERE id = ${mergeId}`;
    await db`DROP TABLE IF EXISTS main.gitdb_backfill_probe CASCADE`;
    await db`DROP FUNCTION IF EXISTS gitdb.sync_backfill_probe()`;
    await db.end({ timeout: 5 });
  });

  it("keeps a row correct when a write lands behind the sweep", async () => {
    await addStep(0);
    await guardedDDL(
      db,
      `CREATE FUNCTION gitdb.sync_backfill_probe() RETURNS trigger AS $$
       BEGIN NEW.new_value := NEW.old_value * 2; RETURN NEW; END $$ LANGUAGE plpgsql;
       CREATE TRIGGER sync_backfill_probe BEFORE INSERT OR UPDATE
       ON main.gitdb_backfill_probe FOR EACH ROW
       EXECUTE FUNCTION gitdb.sync_backfill_probe()`,
      () => {},
    );
    let raced = false;
    await runBackfill(mergeId, step(0), {
      sql: db,
      initialBatchSize: 10,
      vacuumEvery: 20,
      afterBatch: async ({ cursor }) => {
        if (!raced && cursor >= 10) {
          raced = true;
          await db`UPDATE main.gitdb_backfill_probe SET old_value = 99 WHERE id = 1`;
        }
      },
    });
    const [bad] = await db<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM main.gitdb_backfill_probe
       WHERE new_value IS DISTINCT FROM old_value * 2`;
    expect(bad!.count).toBe("0");
  });

  it("demonstrates the same race is corrupt without the trigger", async () => {
    await guardedDDL(
      db,
      `DROP TRIGGER sync_backfill_probe ON main.gitdb_backfill_probe;
       DROP FUNCTION gitdb.sync_backfill_probe()`,
      () => {},
    );
    await db`UPDATE main.gitdb_backfill_probe SET old_value = id, new_value = NULL`;
    await addStep(1);
    let raced = false;
    await runBackfill(mergeId, step(1), {
      sql: db,
      initialBatchSize: 10,
      afterBatch: async ({ cursor }) => {
        if (!raced && cursor >= 10) {
          raced = true;
          await db`UPDATE main.gitdb_backfill_probe SET old_value = 99 WHERE id = 1`;
        }
      },
    });
    const [row] = await db<{ old_value: string; new_value: string }[]>`
      SELECT old_value::text, new_value::text
        FROM main.gitdb_backfill_probe WHERE id = 1`;
    expect(row).toEqual({ old_value: "99", new_value: "2" });
  });
});
