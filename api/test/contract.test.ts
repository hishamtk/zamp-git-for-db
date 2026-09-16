import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContractBlocked, contractMerge, RevertRefused, revertMerge } from "../src/engine/contract.js";
import type { MigrationStep } from "../src/engine/plan.js";
import { persistPlan } from "../src/engine/runner.js";
import { hashIR } from "../src/ir/canonical.js";
import { introspect } from "../src/ir/introspect.js";
import type { SchemaIR } from "../src/ir/types.js";
import { bootstrap } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);
let originalHead: string;
let targetCommit: string;
let targetTableIR: SchemaIR;
const mergeIds: number[] = [];

async function makeMerge(backup: string): Promise<number> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO gitdb.merges (
      source_branch, source_commit, target_commit, base_commit,
      result_ir, plan, state, finished_at
    ) VALUES (
      'contract-test', ${targetCommit}, ${targetCommit}, ${targetCommit},
      ${db.json(targetTableIR as never)}, '[]'::jsonb, 'merged', now()
    ) RETURNING id::text`;
  const id = Number(row!.id);
  mergeIds.push(id);
  const plan: MigrationStep[] = [{
    seq: 0,
    kind: "contract",
    sql: `ALTER TABLE main.gitdb_contract_probe DROP COLUMN "${backup}"`,
    risk: "SAFE",
    manual: true,
    table: "gitdb_contract_probe",
    column: "value",
    shadow: "value__new",
    backup,
  }];
  await persistPlan(db, id, plan);
  await db`
    UPDATE gitdb.merge_steps SET state = 'skipped'
     WHERE merge_id = ${id} AND seq = 0`;
  return id;
}

describe("manual contract and revert", () => {
  beforeAll(async () => {
    await bootstrap(db);
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    originalHead = main!.head_commit;
    await db`DROP TABLE IF EXISTS main.gitdb_contract_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_contract_probe (
        id bigint PRIMARY KEY,
        value bigint NOT NULL
      )`;
    await db`INSERT INTO main.gitdb_contract_probe VALUES (1, 42), (2, 84)`;
    const current = (await introspect(db, "main")).ir;
    const table = current.tables.find((candidate) => candidate.name === "gitdb_contract_probe")!;
    targetTableIR = { version: 1, tables: [table] };
    targetCommit = hashIR(targetTableIR);
    await db`
      INSERT INTO gitdb.commits (id, parent_id, branch, message, ir)
      VALUES (
        ${targetCommit}, ${originalHead}, 'main', 'contract test target',
        ${db.json(targetTableIR as never)}
      ) ON CONFLICT (id) DO NOTHING`;
  });

  afterAll(async () => {
    await db`DELETE FROM gitdb.branches WHERE name = 'contract-blocker'`;
    await db`DROP SCHEMA IF EXISTS br_contract_blocker CASCADE`;
    await db`UPDATE gitdb.branches SET head_commit = ${originalHead} WHERE name = 'main'`;
    if (mergeIds.length) await db`DELETE FROM gitdb.merges WHERE id = ANY(${mergeIds})`;
    await db`DROP TABLE IF EXISTS main.gitdb_contract_probe CASCADE`;
    await db.end({ timeout: 5 });
  });

  it("revert restores the original IR exactly before contract", async () => {
    const backup = "value__old_revert";
    await db`ALTER TABLE main.gitdb_contract_probe ALTER COLUMN value DROP NOT NULL`;
    await db.unsafe(
      `ALTER TABLE main.gitdb_contract_probe RENAME COLUMN value TO "${backup}"`,
    );
    await db`ALTER TABLE main.gitdb_contract_probe ADD COLUMN value numeric`;
    await db`UPDATE main.gitdb_contract_probe SET value = value__old_revert * 2`;
    const mergeId = await makeMerge(backup);

    await revertMerge(mergeId, { sql: db });

    const restored = (await introspect(db, "main")).ir.tables.find(
      (table) => table.name === "gitdb_contract_probe",
    )!;
    expect(hashIR({ version: 1, tables: [restored] })).toBe(hashIR(targetTableIR));
    const rows = await db<{ value: string }[]>`
      SELECT value::text FROM main.gitdb_contract_probe ORDER BY id`;
    expect(rows.map((row) => row.value)).toEqual(["42", "84"]);
  });

  it("blocks referenced old storage, then contract permanently closes revert", async () => {
    const backup = "value__old_contract";
    await db`ALTER TABLE main.gitdb_contract_probe ALTER COLUMN value DROP NOT NULL`;
    await db.unsafe(
      `ALTER TABLE main.gitdb_contract_probe RENAME COLUMN value TO "${backup}"`,
    );
    await db`ALTER TABLE main.gitdb_contract_probe ADD COLUMN value numeric`;
    const mergeId = await makeMerge(backup);
    await db`CREATE SCHEMA br_contract_blocker`;
    await db.unsafe(
      `CREATE VIEW br_contract_blocker.gitdb_contract_probe AS
       SELECT id, "${backup}" AS value FROM main.gitdb_contract_probe`,
    );
    await db`
      INSERT INTO gitdb.branches (name, schema_name, head_commit, base_commit)
      VALUES ('contract-blocker', 'br_contract_blocker', ${targetCommit}, ${targetCommit})`;

    await expect(contractMerge(mergeId, { sql: db })).rejects.toBeInstanceOf(ContractBlocked);
    await db`DELETE FROM gitdb.branches WHERE name = 'contract-blocker'`;
    await db`DROP SCHEMA br_contract_blocker CASCADE`;

    await contractMerge(mergeId, { sql: db });
    const [merge] = await db<{ state: string; contracted_at: Date | null }[]>`
      SELECT state, contracted_at FROM gitdb.merges WHERE id = ${mergeId}`;
    expect(merge!.state).toBe("contracted");
    expect(merge!.contracted_at).toBeInstanceOf(Date);
    await expect(revertMerge(mergeId, { sql: db })).rejects.toBeInstanceOf(RevertRefused);
  });
});
