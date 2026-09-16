import type { Sql } from "../db.js";
import { classify } from "../diff/classify.js";
import type { SchemaOp } from "../diff/diff.js";
import { diff } from "../diff/diff.js";
import { MAIN_SCHEMA, assertTypeExpr, qid, qname } from "../ident.js";
import { canonicalizeTypeString } from "../ir/typecanon.js";
import type { Constraint } from "../ir/types.js";
import { mainIR, workingIR } from "../vcs/branches.js";

/** Measured backfill throughput (BUILD.md). */
export const BACKFILL_ROWS_PER_SEC = 136_000;
/** Typical exclusive-lock window after expand/cutover (BUILD.md). */
export const LOCK_WINDOW_MS = 12;

export type Finding = {
  op: SchemaOp;
  blocked: boolean;
  message: string;
  count?: number;
  samples?: Record<string, unknown>[];
};

export type ValidateReport = {
  branch: string;
  findings: Finding[];
  blocked: boolean;
};

function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatBackfillEta(rows: number): string {
  const sec = Math.max(0, Math.round(rows / BACKFILL_ROWS_PER_SEC));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `backfill ≈ ${m} m ${String(s).padStart(2, "0")} s, lock window ≈ ${LOCK_WINDOW_MS} ms`;
}

function assertCheckExpr(expr: string): string {
  if (!/^[a-zA-Z0-9_."'\s<>=!+\-*/()%,~^$[\]|]+$/.test(expr)) {
    throw new Error(`refusing to probe check expression: ${expr}`);
  }
  return expr;
}

function parseType(t: string): { base: string; mods: number[] } | null {
  const c = canonicalizeTypeString(t);
  const m = /^pg_catalog\.([a-z0-9_]+)(?:\(([^)]*)\))?/.exec(c);
  if (!m) return null;
  return {
    base: m[1]!,
    mods: m[2] ? m[2].split(",").map((x) => Number(x.trim())) : [],
  };
}

/** POSIX regex (not ~*) used with `col::text !~ pattern` as BUILD specifies. */
export function castPattern(toType: string): string | null {
  const t = parseType(toType);
  if (!t) return null;
  switch (t.base) {
    case "int2":
    case "int4":
    case "int8":
      return "^-?[0-9]+$";
    case "float4":
    case "float8":
    case "numeric":
      return "^-?[0-9]+(\\.[0-9]+)?$";
    case "bool":
      return "^(t|f|true|false|0|1)$";
    case "uuid":
      return "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
    case "date":
      return "^[0-9]{4}-[0-9]{2}-[0-9]{2}";
    default:
      return null;
  }
}

async function exists(sql: Sql, schema: string, table: string): Promise<boolean> {
  const [row] = await sql<{ n: string }[]>`
    SELECT 1::text AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind IN ('r','p','v')
     LIMIT 1`;
  return Boolean(row);
}

async function countUnsafe(sql: Sql, q: string): Promise<number> {
  const rows = await sql.unsafe(q);
  const n = (rows[0] as { n?: string | number } | undefined)?.n;
  return Number(n ?? 0);
}

async function rewriteEta(sql: Sql, table: string): Promise<Finding["message"]> {
  const rel = qname(MAIN_SCHEMA, table);
  const rows = await exists(sql, MAIN_SCHEMA, table)
    ? await countUnsafe(sql, `SELECT count(*)::bigint AS n FROM ${rel}`)
    : 0;
  return formatBackfillEta(rows);
}

async function probeNullable(sql: Sql, table: string, column: string): Promise<Finding> {
  const rel = qname(MAIN_SCHEMA, table);
  const col = qid(column);
  const n = await countUnsafe(sql, `SELECT count(*)::bigint AS n FROM ${rel} WHERE ${col} IS NULL`);
  return {
    op: { kind: "set_nullable", table, column, nullable: false },
    blocked: n > 0,
    count: n,
    message: n > 0 ? `blocked: ${fmtCount(n)} rows violate this` : "no NULL rows",
  };
}

async function probeRetype(sql: Sql, op: Extract<SchemaOp, { kind: "retype_column" }>): Promise<Finding> {
  const rel = qname(MAIN_SCHEMA, op.table);
  const col = qid(op.column);
  const parsed = parseType(op.to);
  if (parsed?.base === "varchar" && parsed.mods[0] != null) {
    const n = parsed.mods[0];
    const samples = await sql.unsafe(
      `SELECT ${col} AS value FROM ${rel} WHERE char_length(${col}::text) > ${n} LIMIT 10`,
    );
    const count = await countUnsafe(
      sql,
      `SELECT count(*)::bigint AS n FROM ${rel} WHERE char_length(${col}::text) > ${n}`,
    );
    return {
      op,
      blocked: count > 0,
      count,
      samples: samples as Record<string, unknown>[],
      message: count > 0 ? `blocked: ${fmtCount(count)} rows exceed varchar(${n})` : "all values fit the new type",
    };
  }

  const pattern = castPattern(op.to);
  if (!pattern) {
    return {
      op,
      blocked: false,
      message: `no text pattern for ${assertTypeExpr(op.to)}; rewrite estimated only`,
    };
  }
  const escaped = pattern.replaceAll("'", "''");
  const samples = await sql.unsafe(
    `SELECT ${col} AS value FROM ${rel} WHERE ${col} IS NOT NULL AND ${col}::text !~ '${escaped}' LIMIT 10`,
  );
  const count = await countUnsafe(
    sql,
    `SELECT count(*)::bigint AS n FROM ${rel} WHERE ${col} IS NOT NULL AND ${col}::text !~ '${escaped}'`,
  );
  return {
    op,
    blocked: count > 0,
    count,
    samples: samples as Record<string, unknown>[],
    message: count > 0 ? `blocked: ${fmtCount(count)} rows are not castable` : "all sampled values are castable",
  };
}

async function probeUnique(sql: Sql, table: string, c: Constraint): Promise<Finding> {
  const rel = qname(MAIN_SCHEMA, table);
  const cols = c.columns.map(qid).join(", ");
  // Postgres UNIQUE treats NULL as distinct, so a pile of NULL emails is not a violation.
  const present = c.columns.map((column) => `${qid(column)} IS NOT NULL`).join(" AND ");
  const samples = await sql.unsafe(
    `SELECT ${cols}, count(*)::bigint AS n FROM ${rel} WHERE ${present} GROUP BY ${cols} HAVING count(*) > 1 LIMIT 10`,
  );
  const count = await countUnsafe(
    sql,
    `SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${rel} WHERE ${present} GROUP BY ${cols} HAVING count(*) > 1) d`,
  );
  return {
    op: { kind: "add_constraint", table, constraint: c },
    blocked: count > 0,
    count,
    samples: samples as Record<string, unknown>[],
    message: count > 0 ? `blocked: ${fmtCount(count)} duplicate keys` : "values are unique",
  };
}

async function probeCheck(sql: Sql, table: string, c: Constraint): Promise<Finding> {
  const expr = assertCheckExpr(c.expression ?? "true");
  const rel = qname(MAIN_SCHEMA, table);
  const n = await countUnsafe(sql, `SELECT count(*)::bigint AS n FROM ${rel} WHERE NOT (${expr})`);
  return {
    op: { kind: "add_constraint", table, constraint: c },
    blocked: n > 0,
    count: n,
    message: n > 0 ? `blocked: ${fmtCount(n)} rows violate this` : "check holds for all rows",
  };
}

export async function validateOps(sql: Sql, ops: SchemaOp[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const op of ops) {
    if (!(await exists(sql, MAIN_SCHEMA, tableOf(op)))) {
      if (classify(op) === "REWRITE") {
        out.push({ op, blocked: false, message: formatBackfillEta(0) });
      }
      continue;
    }

    if (op.kind === "set_nullable" && op.nullable === false) {
      const finding = await probeNullable(sql, op.table, op.column);
      finding.op = op;
      out.push(finding);
    } else if (op.kind === "retype_column") {
      out.push(await probeRetype(sql, op));
    } else if (op.kind === "add_constraint" && op.constraint.kind === "unique") {
      out.push(await probeUnique(sql, op.table, op.constraint));
    } else if (op.kind === "add_constraint" && op.constraint.kind === "check") {
      out.push(await probeCheck(sql, op.table, op.constraint));
    }

    if (classify(op) === "REWRITE") {
      out.push({
        op,
        blocked: false,
        message: await rewriteEta(sql, tableOf(op)),
      });
    }
  }
  return out;
}

function tableOf(op: SchemaOp): string {
  switch (op.kind) {
    case "create_table":
      return op.table.name;
    case "drop_table":
      return op.table;
    case "add_column":
    case "drop_column":
    case "rename_column":
    case "retype_column":
    case "set_nullable":
    case "set_default":
    case "add_constraint":
    case "drop_constraint":
    case "add_index":
    case "drop_index":
      return op.table;
  }
}

export async function validateBranch(sql: Sql, branch: string): Promise<ValidateReport> {
  const from = await mainIR(sql);
  const to = await workingIR(sql, branch);
  const findings = await validateOps(sql, diff(from, to));
  return { branch, findings, blocked: findings.some((f) => f.blocked) };
}
