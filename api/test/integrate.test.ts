import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "../src/db.js";
import { hashIR } from "../src/ir/canonical.js";
import { buildApp } from "../src/index.js";
import type { FastifyInstance } from "fastify";

const source = "int-src";
const target = "int-tgt";
let app: FastifyInstance;

async function resetPair(): Promise<void> {
  await sql`DELETE FROM gitdb.merges WHERE source_branch IN (${source}, ${target})`;
  for (const name of [source, target]) {
    const [existing] = await sql`SELECT name FROM gitdb.branches WHERE name = ${name}`;
    if (existing) await app.inject({ method: "DELETE", url: `/api/branches/${name}` });
  }
}

describe("branch integrate", () => {
  beforeAll(async () => {
    app = await buildApp();
    await resetPair();
  });

  afterAll(async () => {
    await resetPair();
    await app.close();
  });

  it("rejects main, identical names, and dirty working trees", async () => {
    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${target}/integrate`,
      payload: { source: "main" },
    })).statusCode).toBe(400);

    await app.inject({ method: "POST", url: "/api/branches", payload: { name: source, from: "main" } });
    await app.inject({ method: "POST", url: "/api/branches", payload: { name: target, from: "main" } });

    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${source}/integrate`,
      payload: { source },
    })).statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: `/api/branches/${source}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN int_dirty text" },
    });
    const dirty = await app.inject({
      method: "POST",
      url: `/api/branches/${target}/integrate`,
      payload: { source },
    });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json()).toMatchObject({ state: "dirty" });
    await resetPair();
  });

  it("previews and applies disjoint commits onto the target without changing main", async () => {
    await app.inject({ method: "POST", url: "/api/branches", payload: { name: source, from: "main" } });
    await app.inject({ method: "POST", url: "/api/branches", payload: { name: target, from: "main" } });

    const mainBefore = await app.inject({ method: "GET", url: "/api/branches/main/schema" });
    const mainHash = mainBefore.json().hash as string;

    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${source}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN int_src_col text" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${source}/commit`,
      payload: { message: "source column" },
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${target}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN int_tgt_col text" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/branches/${target}/commit`,
      payload: { message: "target column" },
    })).statusCode).toBe(200);

    const preview = await app.inject({
      method: "POST",
      url: `/api/branches/${target}/integrate`,
      payload: { source, preview: true },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().commit).toBeNull();
    expect(preview.json().ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "add_column", table: "accounts", column: expect.objectContaining({ name: "int_src_col" }) }),
    ]));

    const targetBeforeApply = await app.inject({ method: "GET", url: `/api/branches/${target}/schema` });
    expect(targetBeforeApply.json().ir.tables.find((t: { name: string }) => t.name === "accounts").columns)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "int_src_col" })]));

    const applied = await app.inject({
      method: "POST",
      url: `/api/branches/${target}/integrate`,
      payload: { source },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().commit).toEqual(expect.any(String));

    const targetAfter = await app.inject({ method: "GET", url: `/api/branches/${target}/schema` });
    const columns = targetAfter.json().ir.tables.find((t: { name: string }) => t.name === "accounts").columns
      .map((c: { name: string }) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["int_src_col", "int_tgt_col"]));
    expect(targetAfter.json().hash).toBe(hashIR(targetAfter.json().ir));

    const mainAfter = await app.inject({ method: "GET", url: "/api/branches/main/schema" });
    expect(mainAfter.json().hash).toBe(mainHash);
    const mainCols = mainAfter.json().ir.tables.find((t: { name: string }) => t.name === "accounts").columns
      .map((c: { name: string }) => c.name);
    expect(mainCols).not.toContain("int_src_col");
    expect(mainCols).not.toContain("int_tgt_col");
    await resetPair();
  });

  it("conflicts when both sides added the same column differently", async () => {
    await app.inject({ method: "POST", url: "/api/branches", payload: { name: source, from: "main" } });
    await app.inject({ method: "POST", url: "/api/branches", payload: { name: target, from: "main" } });

    await app.inject({
      method: "POST",
      url: `/api/branches/${source}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN int_note int" },
    });
    await app.inject({
      method: "POST",
      url: `/api/branches/${source}/commit`,
      payload: { message: "note as int" },
    });
    await app.inject({
      method: "POST",
      url: `/api/branches/${target}/ddl`,
      payload: { sql: "ALTER TABLE accounts ADD COLUMN int_note text" },
    });
    await app.inject({
      method: "POST",
      url: `/api/branches/${target}/commit`,
      payload: { message: "note as text" },
    });

    const conflicted = await app.inject({
      method: "POST",
      url: `/api/branches/${target}/integrate`,
      payload: { source },
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json().state).toBe("conflict");
    expect(conflicted.json().conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "accounts.int_note" }),
    ]));
    await resetPair();
  });
});
