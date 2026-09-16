import { workerSql, type Sql } from "../db.js";
import { qname } from "../ident.js";

export type IndexAttemptEvent = {
  type: "index_attempt";
  index: string;
  attempt: number;
  state: "creating" | "invalid" | "failed" | "valid";
  error?: string;
};

function unquote(identifier: string): string {
  return identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}

export function indexNameFromCreate(sql: string): string {
  const match = sql.match(
    /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+("(?:[^"]|"")*"|[a-zA-Z_][a-zA-Z0-9_$]*)\s+/i,
  );
  if (!match?.[1]) throw new Error(`cannot determine index name from: ${sql}`);
  return unquote(match[1]);
}

async function validIndex(sql: Sql, schema: string, index: string): Promise<boolean> {
  const [row] = await sql<{ indisvalid: boolean }[]>`
    SELECT i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${index}`;
  return row?.indisvalid === true;
}

/**
 * Build an index outside a transaction. Failed/invalid CIC artifacts are removed
 * concurrently before retrying, so they never poison a later resume.
 */
export async function createIndexConcurrently(
  ddl: string,
  options: {
    sql?: Sql;
    schema?: string;
    attempts?: number;
    statementTimeoutMs?: number;
    emit?: (event: IndexAttemptEvent) => void;
  } = {},
): Promise<void> {
  const db = options.sql ?? workerSql;
  const schema = options.schema ?? "main";
  const attempts = options.attempts ?? 3;
  const index = indexNameFromCreate(ddl);
  const timeout = options.statementTimeoutMs ?? 30 * 60_000;
  let lastError: unknown;

  await db.unsafe(`SET statement_timeout = '${Math.max(1, Math.floor(timeout))}ms'`);
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      options.emit?.({ type: "index_attempt", index, attempt, state: "creating" });
      try {
        await db.unsafe(ddl);
        if (await validIndex(db, schema, index)) {
          options.emit?.({ type: "index_attempt", index, attempt, state: "valid" });
          return;
        }
        options.emit?.({ type: "index_attempt", index, attempt, state: "invalid" });
      } catch (error) {
        lastError = error;
        options.emit?.({
          type: "index_attempt",
          index,
          attempt,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${qname(schema, index)}`);
    }
  } finally {
    await db.unsafe("SET statement_timeout = 0");
  }

  throw new Error(
    `CREATE INDEX CONCURRENTLY failed after ${attempts} attempts for ${qname(schema, index)}`,
    { cause: lastError },
  );
}
