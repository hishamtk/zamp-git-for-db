import { sql as defaultSql, type Sql } from "../db.js";
import { qid, qname } from "../ident.js";
import { findTable } from "../ir/types.js";
import { requireCommit } from "../vcs/commits.js";
import { guardedDDLWithViews } from "./deps.js";
import { guardedDDL, type Emit } from "./guarded.js";
import type { MigrationStep } from "./plan.js";

type MergeForFinalization = {
  id: string;
  target_commit: string;
  state: string;
  contracted_at: Date | null;
  plan: unknown;
};

export class ContractBlocked extends Error {
  constructor(readonly branches: string[]) {
    super(`contract blocked by branch views: ${branches.join(", ")}`);
    this.name = "ContractBlocked";
  }
}

export class RevertRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevertRefused";
  }
}

async function loadMerge(sql: Sql, mergeId: number): Promise<MergeForFinalization> {
  const [merge] = await sql<MergeForFinalization[]>`
    SELECT id::text, target_commit, state, contracted_at, plan
      FROM gitdb.merges WHERE id = ${mergeId}`;
  if (!merge) throw new Error(`no such merge: ${mergeId}`);
  return merge;
}

async function columnDependents(
  sql: Sql,
  table: string,
  column: string,
): Promise<string[]> {
  const rows = await sql<{ branch: string | null; schema_name: string; view_name: string }[]>`
    SELECT DISTINCT b.name AS branch, vn.nspname::text AS schema_name, v.relname::text AS view_name
      FROM pg_class t
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid
      JOIN pg_depend d ON d.refobjid = t.oid AND d.refobjsubid = a.attnum
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v'
      JOIN pg_namespace vn ON vn.oid = v.relnamespace
      LEFT JOIN gitdb.branches b ON b.schema_name = vn.nspname
     WHERE tn.nspname = 'main' AND t.relname = ${table} AND a.attname = ${column}
     ORDER BY schema_name, view_name`;
  return rows.map((row) => row.branch ?? qname(row.schema_name, row.view_name));
}

/** Execute only the manual destructive steps and permanently close the revert window. */
export async function contractMerge(
  mergeId: number,
  options: { sql?: Sql; emit?: Emit } = {},
): Promise<void> {
  const sql = options.sql ?? defaultSql;
  const emit = options.emit ?? (() => {});
  const merge = await loadMerge(sql, mergeId);
  if (merge.state !== "merged" || merge.contracted_at) {
    throw new Error(`merge ${mergeId} is not awaiting contract`);
  }
  const plan = merge.plan as MigrationStep[];
  const steps = plan.filter((step) => step.manual || step.kind === "contract");

  for (const step of steps) {
    if (step.table && step.column) {
      const physical = step.backup ?? step.column;
      const blockers = await columnDependents(sql, step.table, physical);
      if (blockers.length) throw new ContractBlocked(blockers);
    }
  }

  for (const step of steps) {
    await guardedDDL(sql, step.sql, emit);
    await sql`
      UPDATE gitdb.merge_steps
         SET state = 'done', error = NULL
       WHERE merge_id = ${mergeId} AND seq = ${step.seq}`;
  }
  await sql`
    UPDATE gitdb.merges
       SET state = 'contracted', contracted_at = now(), finished_at = now()
     WHERE id = ${mergeId}`;
}

function addedColumns(plan: MigrationStep[]): { table: string; column: string }[] {
  const out = new Map<string, { table: string; column: string }>();
  for (const step of plan) {
    if (!step.table || !step.column || step.backup) continue;
    if (step.kind === "expand" || /\bADD\s+COLUMN\b/i.test(step.sql)) {
      out.set(`${step.table}.${step.column}`, { table: step.table, column: step.column });
    }
  }
  return [...out.values()];
}

/** Losslessly restore pre-merge storage while the retained old columns still exist. */
export async function revertMerge(
  mergeId: number,
  options: { sql?: Sql; emit?: Emit } = {},
): Promise<void> {
  const sql = options.sql ?? defaultSql;
  const emit = options.emit ?? (() => {});
  const merge = await loadMerge(sql, mergeId);
  if (merge.contracted_at) {
    throw new RevertRefused(`merge ${mergeId} was contracted and can no longer be reverted`);
  }
  if (merge.state !== "merged") {
    throw new RevertRefused(`merge ${mergeId} is ${merge.state}, not merged`);
  }

  const plan = merge.plan as MigrationStep[];
  const target = (await requireCommit(sql, merge.target_commit)).ir;
  const rewrites = new Map<string, MigrationStep>();
  for (const step of plan) {
    if (step.backup && step.table && step.column) {
      rewrites.set(`${step.table}.${step.column}`, step);
    }
  }

  for (const step of rewrites.values()) {
    const targetColumn = findTable(target, step.table!)?.columns.find(
      (column) => column.name === step.column,
    );
    const restoreNotNull = targetColumn && !targetColumn.nullable
      ? `;\nALTER TABLE ${qname("main", step.table!)} ALTER COLUMN ${qid(step.column!)} SET NOT NULL`
      : "";
    const ddl =
      `ALTER TABLE ${qname("main", step.table!)} DROP COLUMN ${qid(step.column!)};\n` +
      `ALTER TABLE ${qname("main", step.table!)} RENAME COLUMN ${qid(step.backup!)} TO ${qid(step.column!)}` +
      restoreNotNull;
    await guardedDDLWithViews(sql, { ddl, table: step.table!, emit });
  }

  for (const added of addedColumns(plan)) {
    if (rewrites.has(`${added.table}.${added.column}`)) continue;
    await guardedDDLWithViews(sql, {
      ddl: `ALTER TABLE ${qname("main", added.table)} DROP COLUMN IF EXISTS ${qid(added.column)}`,
      table: added.table,
      emit,
    });
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE gitdb.branches
         SET head_commit = ${merge.target_commit}
       WHERE name = 'main'`;
    await tx`
      UPDATE gitdb.merges
         SET state = 'reverted', finished_at = now(), error = NULL
       WHERE id = ${mergeId}`;
  });
}
