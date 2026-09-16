import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedDDL } from "../src/engine/guarded.js";
import { guardedDDLWithViews } from "../src/engine/deps.js";
import { BranchError, createBranch, deleteBranch, getBranch } from "../src/vcs/branches.js";
import { bootstrap, requireCommit, writeCommit } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);
const branch = "task21-idempotent";
const survive = "task21-survive";

describe("branch engine integration", () => {
  beforeAll(async () => {
    await bootstrap(db);
    await db`DELETE FROM gitdb.branches WHERE name IN (${branch}, ${survive})`;
    await db`DROP SCHEMA IF EXISTS br_task21_idempotent CASCADE`;
    await db`DROP SCHEMA IF EXISTS br_task21_survive CASCADE`;
    await db`DROP TABLE IF EXISTS main.gitdb_branch_probe CASCADE`;
    await db`
      CREATE TABLE main.gitdb_branch_probe (
        id bigint PRIMARY KEY,
        memo text
      )`;
    await db`INSERT INTO main.gitdb_branch_probe VALUES (1, 'keep'), (2, 'keep')`;
  });

  afterAll(async () => {
    await db`DELETE FROM gitdb.branches WHERE name IN (${branch}, ${survive})`;
    await db`DROP SCHEMA IF EXISTS br_task21_idempotent CASCADE`;
    await db`DROP SCHEMA IF EXISTS br_task21_survive CASCADE`;
    await db`DROP TABLE IF EXISTS main.gitdb_branch_probe CASCADE`;
    await db.end({ timeout: 5 });
  });

  it("committing an unchanged IR returns the same content-addressed id", async () => {
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    const commit = await requireCommit(db, main!.head_commit);
    const again = await writeCommit(db, {
      branch: "main",
      ir: commit.ir,
      message: "noop",
      parentId: main!.head_commit,
    });
    expect(again.id).toBe(main!.head_commit);
    expect(again.created).toBe(false);
  });

  it("creates a branch idempotently: retry is a clean 409, recreate works", async () => {
    const created = await createBranch(db, { name: branch });
    expect(created.schema_name).toBe("br_task21_idempotent");

    const started = performance.now();
    await expect(createBranch(db, { name: branch })).rejects.toMatchObject({
      status: 409,
      code: "already_exists",
    } satisfies Partial<BranchError>);
    expect(performance.now() - started).toBeLessThan(100);

    const [rows] = await db.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM br_task21_idempotent.accounts`,
    );
    expect(Number(rows!.count)).toBeGreaterThan(0);
    const [size] = await db<{ bytes: string }[]>`
      SELECT pg_total_relation_size('br_task21_idempotent.accounts')::text AS bytes`;
    expect(Number(size!.bytes)).toBeLessThan(64 * 1024);

    await deleteBranch(db, branch);
    expect(await getBranch(db, branch)).toBeNull();
    const recreated = await createBranch(db, { name: branch });
    expect(recreated.name).toBe(branch);
    await deleteBranch(db, branch);
  });

  it("keeps a branch view queryable after parent DDL", async () => {
    await db`CREATE SCHEMA br_task21_survive`;
    await db`
      CREATE VIEW br_task21_survive.gitdb_branch_probe AS
      SELECT id, memo FROM main.gitdb_branch_probe`;
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    await db`
      INSERT INTO gitdb.branches (name, schema_name, head_commit, base_commit)
      VALUES (${survive}, 'br_task21_survive', ${main!.head_commit}, ${main!.head_commit})`;

    await guardedDDL(
      db,
      "ALTER TABLE main.gitdb_branch_probe ADD COLUMN extra text",
      () => {},
    );
    const afterAdd = await db.unsafe<{ count: string; memo: string }[]>(
      `SELECT count(*)::text AS count, min(memo) AS memo
         FROM br_task21_survive.gitdb_branch_probe`,
    );
    expect(afterAdd[0]).toMatchObject({ count: "2", memo: "keep" });

    await guardedDDLWithViews(db, {
      table: "gitdb_branch_probe",
      ddl: "ALTER TABLE main.gitdb_branch_probe ALTER COLUMN id TYPE numeric",
      emit: () => {},
    });
    const afterRetype = await db.unsafe<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM br_task21_survive.gitdb_branch_probe`,
    );
    expect(afterRetype[0]!.count).toBe("2");
  });
});
