import { isLockNotAvailable, type Sql } from "../db.js";

export type EmitEvent = { type: "lock_retry"; attempt: number; ddl: string };

export type Emit = (event: EmitEvent) => void;
export type GuardedWork<T = unknown> = (tx: Sql) => Promise<T>;

export class CouldNotAcquireLock extends Error {
  readonly ddl: string;
  constructor(ddl: string) {
    super(`could not acquire lock: ${ddl}`);
    this.name = "CouldNotAcquireLock";
    this.ddl = ddl;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run one DDL statement with `lock_timeout = 500ms` so a blocked `ALTER`
 * aborts instead of stalling readers. Retries with exponential backoff.
 *
 * `CREATE INDEX CONCURRENTLY` cannot use this — it cannot run in a transaction.
 */
export async function guardedDDL<T = { attempt: number }>(
  sql: Sql,
  ddl: string,
  emit: Emit,
  attempts?: number,
): Promise<T>;
export async function guardedDDL<T>(
  sql: Sql,
  ddl: string,
  emit: Emit,
  attempts: number | undefined,
  work: GuardedWork<T>,
): Promise<T>;
export async function guardedDDL<T>(
  sql: Sql,
  ddl: string,
  emit: Emit,
  attempts = 15,
  work?: GuardedWork<T>,
): Promise<T | { attempt: number }> {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '500ms'`;
        if (work) return work(tx as unknown as Sql);
        await tx.unsafe(ddl);
        return { attempt: i };
      });
      return result as T | { attempt: number };
    } catch (e: unknown) {
      if (!isLockNotAvailable(e)) throw e;
      emit({ type: "lock_retry", attempt: i, ddl });
      await sleep(Math.min(100 * 2 ** i, 5000) * (0.5 + Math.random()));
    }
  }
  throw new CouldNotAcquireLock(ddl);
}
