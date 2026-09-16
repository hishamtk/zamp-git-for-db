import { workerSql, type Sql } from "../db.js";
import { qid, qname } from "../ident.js";
import type { MigrationStep } from "./plan.js";

export type BackfillProgress = {
  type: "backfill_progress";
  mergeId: number;
  seq: number;
  rowsDone: number;
  rowsTotal: number;
  rowsPerSec: number;
  etaSec: number;
  bloatBytes: number;
  cursor: number;
  batchSize: number;
};

export type BackfillOptions = {
  sql?: Sql;
  initialBatchSize?: number;
  vacuumEvery?: number;
  emit?: (event: BackfillProgress) => void;
  afterBatch?: (event: BackfillProgress) => Promise<void> | void;
};

function required(step: MigrationStep, key: "table" | "pk" | "expression" | "shadow"): string {
  const value = step[key];
  if (!value) throw new Error(`backfill step ${step.seq} has no ${key}`);
  return value;
}

/** Resume a PK-range backfill from the cursor persisted on its merge step. */
export async function runBackfill(
  mergeId: number,
  step: MigrationStep,
  options: BackfillOptions = {},
): Promise<void> {
  const db = options.sql ?? workerSql;
  const table = required(step, "table");
  const pk = required(step, "pk");
  const expression = required(step, "expression");
  const shadow = required(step, "shadow");
  const relation = qname("main", table);
  const vacuumEvery = options.vacuumEvery ?? 20;
  let batchSize = options.initialBatchSize ?? 10_000;

  const [bounds] = await db.unsafe<{ lo: string | null; hi: string | null; total: string }[]>(
    `SELECT min(${qid(pk)})::text AS lo,
            max(${qid(pk)})::text AS hi,
            count(*)::text AS total
       FROM ${relation}`,
  );
  if (!bounds?.lo || !bounds.hi) {
    await db`
      UPDATE gitdb.merge_steps
         SET rows_done = 0, rows_total = 0, cursor = NULL
       WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
    return;
  }

  const [saved] = await db<{ cursor: string | null; rows_done: string; rows_total: string | null }[]>`
    SELECT cursor::text, rows_done::text, rows_total::text
      FROM gitdb.merge_steps
     WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
  if (!saved) throw new Error(`merge step ${mergeId}/${step.seq} is not persisted`);

  const lo = Number(bounds.lo);
  const hi = Number(bounds.hi);
  const rowsTotal = Number(saved.rows_total ?? bounds.total);
  let cursor = saved.cursor == null ? lo - 1 : Number(saved.cursor);
  let rowsDone = Number(saved.rows_done);
  let batches = 0;
  const started = performance.now();

  await db`
    UPDATE gitdb.merge_steps
       SET rows_total = ${rowsTotal}, cursor = ${cursor}
     WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;

  while (cursor < hi) {
    const upper = Math.min(cursor + batchSize, hi);
    const before = performance.now();
    const updated = (await db.begin(async (tx) => {
      const rows = await tx.unsafe(
        `UPDATE ${relation}
            SET ${qid(shadow)} = ${expression}
          WHERE ${qid(pk)} > $1 AND ${qid(pk)} <= $2
          RETURNING 1`,
        [cursor, upper],
      );
      await tx`
        UPDATE gitdb.merge_steps
           SET cursor = ${upper},
               rows_done = rows_done + ${rows.length},
               rows_total = ${rowsTotal}
         WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
      return rows.length;
    })) as unknown as number;
    const elapsedMs = Math.max(performance.now() - before, 1);
    cursor = upper;
    rowsDone += updated;
    batches += 1;

    if (batches % vacuumEvery === 0 && cursor < hi) {
      await db.unsafe(`VACUUM ${relation}`);
    }

    const [size] = await db<{ bloat: string }[]>`
      SELECT greatest(
        pg_total_relation_size(${relation}::regclass) -
        pg_relation_size(${relation}::regclass),
        0
      )::text AS bloat`;
    const totalSeconds = Math.max((performance.now() - started) / 1000, 0.001);
    const rowsPerSec = rowsDone / totalSeconds;
    const event: BackfillProgress = {
      type: "backfill_progress",
      mergeId,
      seq: step.seq,
      rowsDone,
      rowsTotal,
      rowsPerSec,
      etaSec: rowsPerSec > 0 ? Math.max(rowsTotal - rowsDone, 0) / rowsPerSec : 0,
      bloatBytes: Number(size?.bloat ?? 0),
      cursor,
      batchSize,
    };
    options.emit?.(event);
    await options.afterBatch?.(event);

    if (elapsedMs > 1000) batchSize = Math.max(Math.floor(batchSize / 2), 100);
    else if (elapsedMs < 200) batchSize = Math.min(Math.floor(batchSize * 1.5), 500_000);
  }
}
