import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql, workerSql } from "../src/db.js";
import { contractMerge } from "../src/engine/contract.js";
import { insertPlannedMerge, runMerge } from "../src/engine/runner.js";
import { buildApp } from "../src/index.js";
import { applySchemaOps } from "../src/ir/parse.js";
import { introspect } from "../src/ir/introspect.js";
import { requireBranch } from "../src/vcs/branches.js";
import { writeCommit } from "../src/vcs/commits.js";

const TABLE = "gitdb_rewind_probe";
const DIRTY_BRANCH = "rewind-dirty";
let app: FastifyInstance;
let originalHead: string;
const mergeIds: number[] = [];

async function commitMain(message: string): Promise<string> {
  const ir = (await introspect(sql, "main")).ir;
  const main = await requireBranch(sql, "main");
  const result = await writeCommit(sql, {
    branch: "main",
    ir,
    message,
    parentId: main.head_commit,
  });
  return result.id;
}

async function headOfMain(): Promise<string> {
  const main = await requireBranch(sql, "main");
  if (!main.head_commit) throw new Error("main has no head");
  return main.head_commit;
}

describe("rewind main", () => {
  beforeAll(async () => {
    app = await buildApp();
    await workerSql`SELECT pg_advisory_unlock_all()`;
    await sql`
      UPDATE gitdb.merges
         SET state = 'failed', error = 'rewind test cleanup'
       WHERE state = 'running'`;
    originalHead = await headOfMain();
    await sql.unsafe(`DROP TABLE IF EXISTS main.${TABLE} CASCADE`);
    await sql.unsafe(`
      CREATE TABLE main.${TABLE} (
        id bigint PRIMARY KEY,
        amount bigint NOT NULL
      )`);
    await sql.unsafe(`INSERT INTO main.${TABLE} (id, amount) VALUES (1, 42), (2, 84)`);
    await commitMain("rewind probe base");
  });

  afterAll(async () => {
    const [existing] = await sql`SELECT name FROM gitdb.branches WHERE name = ${DIRTY_BRANCH}`;
    if (existing) await app.inject({ method: "DELETE", url: `/api/branches/${DIRTY_BRANCH}` });
    if (mergeIds.length) await sql`DELETE FROM gitdb.merges WHERE id = ANY(${mergeIds})`;
    await sql.unsafe(`DROP TABLE IF EXISTS main.${TABLE} CASCADE`);
    await sql`UPDATE gitdb.branches SET head_commit = ${originalHead} WHERE name = 'main'`;
    await app.close();
  });

  it("refuses a commit that is not on main's parent chain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { commit: "not-an-ancestor" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "not_ancestor" });
  });

  it("refuses rewind while a feature branch is dirty", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/branches",
      payload: { name: DIRTY_BRANCH, from: "main" },
    });
    expect(created.statusCode).toBe(201);
    const ddl = await app.inject({
      method: "POST",
      url: `/api/branches/${DIRTY_BRANCH}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN rewind_dirty_note text" },
    });
    expect(ddl.statusCode).toBe(200);

    const target = (await sql<{ parent_id: string | null }[]>`
      SELECT parent_id FROM gitdb.commits WHERE id = ${await headOfMain()}`)[0];
    const res = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { commit: target?.parent_id ?? originalHead },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ state: "dirty", branch: DIRTY_BRANCH });

    await app.inject({ method: "DELETE", url: `/api/branches/${DIRTY_BRANCH}` });
  });

  it("rewinds N commits with one compiled plan and does not auto-contract", async () => {
    await sql.unsafe(`ALTER TABLE main.${TABLE} ADD COLUMN note_a text`);
    await commitMain("add note_a");
    await sql.unsafe(`ALTER TABLE main.${TABLE} ADD COLUMN note_b text`);
    await commitMain("add note_b");

    const preview = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { mergesBack: 2 },
    });
    expect(preview.statusCode).toBe(201);
    const body = preview.json() as {
      id: number;
      plan: Array<{ kind: string; table?: string; column?: string; manual?: boolean }>;
      undone: unknown[];
      targetCommit: string;
    };
    mergeIds.push(body.id);
    expect(body.undone).toHaveLength(2);
    expect(body.plan.filter((step) => step.kind === "contract" && step.table === TABLE)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "note_b", manual: true }),
        expect.objectContaining({ column: "note_a", manual: true }),
      ]),
    );

    const applied = await app.inject({ method: "POST", url: `/api/rewinds/${body.id}/apply` });
    if (applied.statusCode !== 200) {
      throw new Error(`rewind apply failed: ${applied.statusCode} ${applied.body}`);
    }
    expect(applied.statusCode).toBe(200);
    expect(applied.json().contracted_at).toBeNull();
    expect(await headOfMain()).toBe(body.targetCommit);

    const cols = await sql<{ attname: string }[]>`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relname = ${TABLE} AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attname`;
    expect(cols.map((row) => row.attname)).toEqual(expect.arrayContaining(["amount", "note_a", "note_b"]));
  });

  it("restores reconstructible retype values after contract via expand/backfill", async () => {
    const before = await commitMain("retype rewind source");
    const from = (await introspect(sql, "main")).ir;
    const ops = [{
      kind: "retype_column" as const,
      table: TABLE,
      column: "amount",
      from: "pg_catalog.int8",
      to: "pg_catalog.numeric",
    }];
    const resultIR = applySchemaOps(from, ops);
    const main = await requireBranch(sql, "main");
    const { id: forwardId, plan } = await insertPlannedMerge(sql, {
      sourceBranch: "rewind-retype-forward",
      sourceCommit: main.head_commit!,
      targetCommit: main.head_commit!,
      baseCommit: main.head_commit!,
      resultIR,
      fromIR: from,
      ops,
    });
    mergeIds.push(forwardId);
    await runMerge(forwardId, { sql, worker: sql, plan });
    await contractMerge(forwardId, { sql });

    const typ = await sql<{ typname: string }[]>`
      SELECT t.typname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = 'main' AND c.relname = ${TABLE} AND a.attname = 'amount'`;
    expect(typ[0]?.typname).toBe("numeric");

    const preview = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { commit: before },
    });
    expect(preview.statusCode).toBe(201);
    const body = preview.json() as { id: number; plan: Array<{ kind: string; table?: string }> };
    mergeIds.push(body.id);
    expect(body.plan.some((step) => step.kind === "backfill" && step.table === TABLE)).toBe(true);

    const applied = await app.inject({ method: "POST", url: `/api/rewinds/${body.id}/apply` });
    expect(applied.statusCode).toBe(200);
    expect(await headOfMain()).toBe(before);

    const restored = await sql.unsafe(
      `SELECT amount::text AS amount FROM main.${TABLE} ORDER BY id`,
    ) as { amount: string }[];
    expect(restored.map((row) => row.amount)).toEqual(["42", "84"]);
    const restoredType = await sql<{ typname: string }[]>`
      SELECT t.typname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = 'main' AND c.relname = ${TABLE}
         AND a.attname = 'amount' AND NOT a.attisdropped`;
    expect(restoredType[0]?.typname).toBe("int8");
    const leftover = await sql<{ attname: string }[]>`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relname = ${TABLE}
         AND a.attnum > 0 AND NOT a.attisdropped
         AND (a.attname ~ '__new$' OR a.attname ~ '__old_')`;
    expect(leftover).toEqual([]);
  });

  it("rewind drops expand backups left by an uncontracted merge", async () => {
    await sql.unsafe(`ALTER TABLE main.${TABLE} ADD COLUMN IF NOT EXISTS title text`);
    await sql.unsafe(`UPDATE main.${TABLE} SET title = 'n' WHERE title IS NULL`);
    const before = await commitMain("title text");
    const from = (await introspect(sql, "main")).ir;
    const ops = [{
      kind: "retype_column" as const,
      table: TABLE,
      column: "title",
      from: "pg_catalog.text",
      to: "pg_catalog.varchar(200)",
    }];
    const resultIR = applySchemaOps(from, ops);
    const main = await requireBranch(sql, "main");
    const { id: forwardId, plan } = await insertPlannedMerge(sql, {
      sourceBranch: "rewind-uncontracted",
      sourceCommit: main.head_commit!,
      targetCommit: main.head_commit!,
      baseCommit: main.head_commit!,
      resultIR,
      fromIR: from,
      ops,
    });
    mergeIds.push(forwardId);
    await runMerge(forwardId, { sql, worker: sql, plan });

    const preview = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { commit: before },
    });
    expect(preview.statusCode).toBe(201);
    const body = preview.json() as {
      id: number;
      plan: Array<{ kind: string; column?: string; sql?: string }>;
    };
    mergeIds.push(body.id);
    expect(body.plan.some((step) => (step.column ?? "").includes("__old_"))).toBe(true);

    const applied = await app.inject({ method: "POST", url: `/api/rewinds/${body.id}/apply` });
    expect(applied.statusCode).toBe(200);

    const leftover = await sql<{ attname: string }[]>`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relname = ${TABLE}
         AND a.attnum > 0 AND NOT a.attisdropped
         AND (a.attname ~ '__new$' OR a.attname ~ '__old_')`;
    expect(leftover).toEqual([]);
    const typ = await sql<{ typname: string }[]>`
      SELECT t.typname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = 'main' AND c.relname = ${TABLE} AND a.attname = 'title' AND NOT a.attisdropped`;
    expect(typ[0]?.typname).toBe("text");
  });

  it("does not pull leftover catalog drift into the rewind plan", async () => {
    const leftovers = await sql<{ attname: string }[]>`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'main' AND c.relname = ${TABLE}
         AND a.attnum > 0 AND NOT a.attisdropped
         AND (a.attname ~ '__new$' OR a.attname ~ '__old_')`;
    for (const col of leftovers) {
      await sql.unsafe(`ALTER TABLE main.${TABLE} DROP COLUMN IF EXISTS ${col.attname}`);
    }
    await sql.unsafe(`ALTER TABLE main.${TABLE} ADD COLUMN IF NOT EXISTS rewind_only text`);
    await commitMain("probe-only change");
    await sql.unsafe(`ALTER TABLE main.${TABLE} ADD COLUMN IF NOT EXISTS leftover__new text`);
    try {
      const preview = await app.inject({
        method: "POST",
        url: "/api/rewinds",
        payload: { mergesBack: 1 },
      });
      expect(preview.statusCode).toBe(201);
      const body = preview.json() as {
        id: number;
        ops: Array<{ kind: string; table?: string; column?: string }>;
        plan: Array<{ column?: string }>;
      };
      mergeIds.push(body.id);
      expect(body.ops).toEqual([
        expect.objectContaining({ kind: "drop_column", table: TABLE, column: "rewind_only" }),
      ]);
      expect(body.plan.some((step) => step.column === "leftover__new")).toBe(true);
    } finally {
      await sql.unsafe(`ALTER TABLE main.${TABLE} DROP COLUMN IF EXISTS leftover__new`);
    }
  });

  it("refuses apply while another merge is running", async () => {
    const parent = (await sql<{ parent_id: string | null }[]>`
      SELECT parent_id FROM gitdb.commits WHERE id = ${await headOfMain()}`)[0]?.parent_id;
    const planned = await app.inject({
      method: "POST",
      url: "/api/rewinds",
      payload: { commit: parent },
    });
    expect(planned.statusCode).toBe(201);
    const rewindId = planned.json().id as number;
    mergeIds.push(rewindId);

    const [blocker] = await sql<{ id: string }[]>`
      INSERT INTO gitdb.merges (
        source_branch, source_commit, target_commit, base_commit, plan, state
      ) VALUES (
        'rewind-lock', ${await headOfMain()}, ${await headOfMain()}, ${await headOfMain()},
        '[]'::jsonb, 'running'
      ) RETURNING id::text`;
    mergeIds.push(Number(blocker!.id));

    const applied = await app.inject({ method: "POST", url: `/api/rewinds/${rewindId}/apply` });
    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toMatchObject({ state: "merge_in_progress" });

    await sql`UPDATE gitdb.merges SET state = 'failed' WHERE id = ${blocker!.id}`;
  });
});
