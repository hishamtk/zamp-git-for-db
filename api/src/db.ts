import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

const url =
  process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";

/**
 * Request-path pool. Short queries only.
 */
export const sql: Sql = postgres(url, {
  max: 20,
  idle_timeout: 30,
  // DDL and catalog queries must not be prepared/cached across schema changes.
  prepare: false,
  onnotice: () => {},
});

/**
 * Dedicated single connection for the migration worker.
 *
 * A backfill holds one connection for minutes at a time. Borrowing that from the
 * request pool would starve the API, and a pool rotation mid-migration would lose
 * session state (advisory locks, GUCs) that the executor depends on.
 */
export const workerSql: Sql = postgres(url, {
  max: 1,
  idle_timeout: 0,
  max_lifetime: 0,
  connect_timeout: 30,
  prepare: false,
  onnotice: () => {},
});

/** Postgres error code for `lock_timeout` expiry. */
export const LOCK_NOT_AVAILABLE = "55P03";
/** Postgres error code for `statement_timeout` / query cancellation. */
export const QUERY_CANCELED = "57014";

export function isLockNotAvailable(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE;
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([sql.end({ timeout: 5 }), workerSql.end({ timeout: 5 })]);
}
