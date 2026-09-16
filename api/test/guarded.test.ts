import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { CouldNotAcquireLock, guardedDDL, type EmitEvent } from "../src/engine/guarded.js";

const url = process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";

const sql = postgres(url, { max: 4, prepare: false, onnotice: () => {} });
const blocker = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

afterAll(async () => {
  await Promise.allSettled([sql.end({ timeout: 5 }), blocker.end({ timeout: 5 })]);
});

describe("guardedDDL", () => {
  it(
    "retries on lock_timeout instead of blocking readers",
    async () => {
      await sql.unsafe(`DROP TABLE IF EXISTS main.gitdb_lock_probe`);
      await sql.unsafe(`CREATE TABLE main.gitdb_lock_probe (id int PRIMARY KEY)`);
      await sql.unsafe(`INSERT INTO main.gitdb_lock_probe (id) VALUES (1)`);

      const events: EmitEvent[] = [];
      try {
        await blocker.begin(async (tx) => {
          await tx`SELECT id FROM main.gitdb_lock_probe`;

          const ddlP = guardedDDL(
            sql,
            `ALTER TABLE main.gitdb_lock_probe ADD COLUMN x int`,
            (e) => events.push(e),
            3,
          );

          const t0 = performance.now();
          await tx`SELECT id FROM main.gitdb_lock_probe WHERE id = 1`;
          const selectMs = performance.now() - t0;
          expect(selectMs).toBeLessThan(50);

          await expect(ddlP).rejects.toBeInstanceOf(CouldNotAcquireLock);
        });

        expect(events.filter((e) => e.type === "lock_retry").length).toBeGreaterThanOrEqual(1);
      } finally {
        await sql.unsafe(`DROP TABLE IF EXISTS main.gitdb_lock_probe`);
      }
    },
    25_000,
  );
});
