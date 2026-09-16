import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardedDDLWithViews, UnknownDependentView } from "../src/engine/deps.js";
import { bootstrap } from "../src/vcs/commits.js";

const db = postgres(
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb",
  { max: 2, prepare: false, onnotice: () => {} },
);
const names = ["dep-a", "dep-b", "dep-c"];

describe("branch view dependency resolver", () => {
  beforeAll(async () => {
    await bootstrap(db);
    await db`DROP TABLE IF EXISTS main.gitdb_dep_probe CASCADE`;
    await db`CREATE TABLE main.gitdb_dep_probe (id integer PRIMARY KEY, memo text)`;
    const [main] = await db<{ head_commit: string }[]>`
      SELECT head_commit FROM gitdb.branches WHERE name = 'main'`;
    for (const name of names) {
      const schema = `br_${name.replaceAll("-", "_")}`;
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db.unsafe(`CREATE SCHEMA "${schema}"`);
      await db.unsafe(
        `CREATE VIEW "${schema}".gitdb_dep_probe AS SELECT id, memo FROM main.gitdb_dep_probe`,
      );
      await db`
        INSERT INTO gitdb.branches (name, schema_name, head_commit, base_commit)
        VALUES (${name}, ${schema}, ${main!.head_commit}, ${main!.head_commit})
        ON CONFLICT (name) DO UPDATE SET schema_name = EXCLUDED.schema_name,
          head_commit = EXCLUDED.head_commit, stale_reason = NULL`;
    }
  });

  afterAll(async () => {
    await db`DELETE FROM gitdb.branches WHERE name = ANY(${names})`;
    for (const name of names) {
      await db.unsafe(`DROP SCHEMA IF EXISTS "br_${name.replaceAll("-", "_")}" CASCADE`);
    }
    await db`DROP SCHEMA IF EXISTS gitdb_unknown_dep CASCADE`;
    await db`DROP TABLE IF EXISTS main.gitdb_dep_probe CASCADE`;
    await db.end({ timeout: 5 });
  });

  it("retypes with three open branches and recreates every view", async () => {
    await guardedDDLWithViews(db, {
      table: "gitdb_dep_probe",
      ddl: "ALTER TABLE main.gitdb_dep_probe ALTER COLUMN id TYPE bigint",
      emit: () => {},
    });
    for (const name of names) {
      const schema = `br_${name.replaceAll("-", "_")}`;
      const [row] = await db.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "${schema}".gitdb_dep_probe`,
      );
      expect(row!.count).toBe("0");
    }
  });

  it("marks a branch stale when main drops a referenced column", async () => {
    await guardedDDLWithViews(db, {
      table: "gitdb_dep_probe",
      ddl: "ALTER TABLE main.gitdb_dep_probe DROP COLUMN memo",
      emit: () => {},
    });
    const rows = await db<{ stale_reason: string | null }[]>`
      SELECT stale_reason FROM gitdb.branches WHERE name = ANY(${names})`;
    expect(rows.every((row) => row.stale_reason?.includes("main dropped `memo`"))).toBe(true);
  });

  it("fails loudly for a dependent view outside the branch registry", async () => {
    await db`CREATE SCHEMA IF NOT EXISTS gitdb_unknown_dep`;
    await db`
      CREATE VIEW gitdb_unknown_dep.probe AS
      SELECT id FROM main.gitdb_dep_probe`;
    await expect(
      guardedDDLWithViews(db, {
        table: "gitdb_dep_probe",
        ddl: "ALTER TABLE main.gitdb_dep_probe ALTER COLUMN id TYPE numeric",
        emit: () => {},
      }),
    ).rejects.toBeInstanceOf(UnknownDependentView);
  });
});
