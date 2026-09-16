import { EventEmitter } from "node:events";
import type { Sql } from "./db.js";

const bus = new EventEmitter();
bus.setMaxListeners(100);

export type TelemetryEvent = Record<string, unknown>;

export async function emitMergeEvent(sql: Sql, mergeId: number, payload: TelemetryEvent): Promise<void> {
  bus.emit(String(mergeId), payload);
  await sql`
    INSERT INTO gitdb.events (merge_id, level, payload)
    VALUES (${mergeId}, 'info', ${sql.json(payload as never)})`;
}

export function subscribeMerge(mergeId: number, listener: (event: TelemetryEvent) => void): () => void {
  const key = String(mergeId);
  bus.on(key, listener);
  return () => bus.off(key, listener);
}
