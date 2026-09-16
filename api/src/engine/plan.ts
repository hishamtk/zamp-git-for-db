import { classify, defaultIsVolatile, type Risk } from "../diff/classify.js";
import type { SchemaOp } from "../diff/diff.js";
import { isBinaryCoercible } from "../ir/typecanon.js";
import { findTable, type SchemaIR } from "../ir/types.js";
import { MAIN_SCHEMA, assertTypeExpr, qid, qname } from "../ident.js";
import { createTableSQL } from "./views.js";

export type StepKind =
  | "ddl"
  | "expand"
  | "sync"
  | "backfill"
  | "validate"
  | "cutover"
  | "contract"
  | "index_concurrent";

export type MigrationStep = {
  seq: number;
  kind: StepKind;
  sql: string;
  risk: Risk;
  /** CONTRACT is never executed by the runner. */
  manual?: boolean;
  table?: string;
  column?: string;
  shadow?: string;
  /** Assignment expression used by backfill/sync, e.g. `"amount_cents" / 100.0`. */
  expression?: string;
  pk?: string;
  /** Reversible copy retained until manual contract. */
  backup?: string;
  index?: string;
};

export type PlanCtx = {
  schema?: string;
  mergeId: number;
  from: SchemaIR;
};

function rel(ctx: PlanCtx, table: string): string {
  return qname(ctx.schema ?? MAIN_SCHEMA, table);
}

function pkColumn(ctx: PlanCtx, table: string): string {
  const t = findTable(ctx.from, table);
  const pk = t?.constraints.find((c) => c.kind === "primary");
  const name = pk?.columns[0] ?? t?.columns[0]?.name;
  if (!name) throw new Error(`no primary key for table ${table}`);
  return name;
}

function ident(name: string): string {
  return qid(name);
}

function nnConstraint(mergeId: number, table: string, column: string): string {
  return ident(`gitdb_nn_${mergeId}_${table}_${column}`.slice(0, 63));
}

function shadowName(column: string): string {
  const s = `${column}__new`;
  return s.length <= 63 ? s : `${column.slice(0, 57)}__new`;
}

function backupName(column: string, mergeId: number): string {
  const suffix = `__old_${mergeId}`;
  return `${column.slice(0, 63 - suffix.length)}${suffix}`;
}

function usingExpr(op: Extract<SchemaOp, { kind: "retype_column" }>): string {
  return op.using ?? `${ident(op.column)}::${assertTypeExpr(op.to)}`;
}

function push(steps: MigrationStep[], step: Omit<MigrationStep, "seq">): void {
  steps.push({ ...step, seq: steps.length });
}

function addNotNullPipeline(steps: MigrationStep[], ctx: PlanCtx, table: string, column: string): void {
  const r = rel(ctx, table);
  const c = ident(column);
  const con = nnConstraint(ctx.mergeId, table, column);
  push(steps, {
    kind: "ddl",
    sql: `ALTER TABLE ${r} ADD CONSTRAINT ${con} CHECK (${c} IS NOT NULL) NOT VALID`,
    risk: "LOCKING",
    table,
    column,
  });
  push(steps, {
    kind: "validate",
    sql: `ALTER TABLE ${r} VALIDATE CONSTRAINT ${con}`,
    risk: "LOCKING",
    table,
    column,
  });
  push(steps, {
    kind: "ddl",
    sql: `ALTER TABLE ${r} ALTER COLUMN ${c} SET NOT NULL`,
    risk: "LOCKING",
    table,
    column,
  });
  push(steps, {
    kind: "ddl",
    sql: `ALTER TABLE ${r} DROP CONSTRAINT ${con}`,
    risk: "SAFE",
    table,
    column,
  });
}

function rewriteRetype(steps: MigrationStep[], ctx: PlanCtx, op: Extract<SchemaOp, { kind: "retype_column" }>): void {
  const table = op.table;
  const r = rel(ctx, table);
  const shadow = shadowName(op.column);
  const backup = backupName(op.column, ctx.mergeId);
  const expr = usingExpr(op);
  const pk = pkColumn(ctx, table);
  const fromCol = findTable(ctx.from, table)?.columns.find((c) => c.name === op.column);
  const notNull = fromCol ? !fromCol.nullable : true;

  push(steps, {
    kind: "expand",
    sql: `ALTER TABLE ${r} ADD COLUMN ${ident(shadow)} ${assertTypeExpr(op.to)}`,
    risk: "REWRITE",
    table,
    column: op.column,
    shadow,
    backup,
    expression: expr,
    pk,
  });
  const fn = ident(`sync_${ctx.mergeId}_${table}_${shadow}`.slice(0, 63));
  const tg = ident(`sync_${ctx.mergeId}_${table}_${shadow}`.slice(0, 63));
  push(steps, {
    kind: "sync",
    sql:
      `CREATE FUNCTION gitdb.${fn}() RETURNS trigger AS $$ BEGIN NEW.${ident(shadow)} := ${expr.replaceAll(ident(op.column), `NEW.${ident(op.column)}`)}; RETURN NEW; END $$ LANGUAGE plpgsql;\n` +
      `CREATE TRIGGER ${tg} BEFORE INSERT OR UPDATE ON ${r} FOR EACH ROW EXECUTE FUNCTION gitdb.${fn}()`,
    risk: "REWRITE",
    table,
    column: op.column,
    shadow,
    backup,
    expression: expr,
    pk,
  });
  push(steps, {
    kind: "backfill",
    sql: `UPDATE ${r} SET ${ident(shadow)} = ${expr} WHERE ${ident(pk)} > $cursor AND ${ident(pk)} <= $cursor + $batch`,
    risk: "REWRITE",
    table,
    column: op.column,
    shadow,
    backup,
    expression: expr,
    pk,
  });
  if (notNull) addNotNullPipeline(steps, ctx, table, shadow);
  push(steps, {
    kind: "cutover",
    sql: [
      `DROP TRIGGER IF EXISTS ${tg} ON ${r}`,
      `DROP FUNCTION IF EXISTS gitdb.${fn}()`,
      `ALTER TABLE ${r} ALTER COLUMN ${ident(op.column)} DROP NOT NULL`,
      `ALTER TABLE ${r} RENAME COLUMN ${ident(op.column)} TO ${ident(backup)}`,
      `ALTER TABLE ${r} RENAME COLUMN ${ident(shadow)} TO ${ident(op.column)}`,
    ].join(";\n"),
    risk: "REWRITE",
    table,
    column: op.column,
    shadow,
    backup,
    expression: expr,
    pk,
  });
  push(steps, {
    kind: "contract",
    sql: `ALTER TABLE ${r} DROP COLUMN ${ident(backup)}`,
    risk: "SAFE",
    manual: true,
    table,
    column: op.column,
    shadow,
    backup,
  });
}

function rewriteVolatileAdd(steps: MigrationStep[], ctx: PlanCtx, op: Extract<SchemaOp, { kind: "add_column" }>): void {
  const table = op.table;
  const r = rel(ctx, table);
  const col = op.column;
  const expr = col.default!;
  const pk = pkColumn(ctx, table);
  push(steps, {
    kind: "expand",
    sql: `ALTER TABLE ${r} ADD COLUMN ${ident(col.name)} ${assertTypeExpr(col.type)}`,
    risk: "REWRITE",
    table,
    column: col.name,
    shadow: col.name,
    expression: expr,
    pk,
  });
  const fn = ident(`sync_${ctx.mergeId}_${table}_${col.name}`.slice(0, 63));
  push(steps, {
    kind: "sync",
    sql:
      `CREATE FUNCTION gitdb.${fn}() RETURNS trigger AS $$ BEGIN IF NEW.${ident(col.name)} IS NULL THEN NEW.${ident(col.name)} := ${expr}; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;\n` +
      `CREATE TRIGGER ${fn} BEFORE INSERT OR UPDATE ON ${r} FOR EACH ROW EXECUTE FUNCTION gitdb.${fn}()`,
    risk: "REWRITE",
    table,
    column: col.name,
    shadow: col.name,
    expression: expr,
    pk,
  });
  push(steps, {
    kind: "backfill",
    sql: `UPDATE ${r} SET ${ident(col.name)} = ${expr} WHERE ${ident(col.name)} IS NULL AND ${ident(pk)} > $cursor AND ${ident(pk)} <= $cursor + $batch`,
    risk: "REWRITE",
    table,
    column: col.name,
    shadow: col.name,
    expression: expr,
    pk,
  });
  if (!col.nullable) addNotNullPipeline(steps, ctx, table, col.name);
  push(steps, {
    kind: "ddl",
    sql: `ALTER TABLE ${r} ALTER COLUMN ${ident(col.name)} SET DEFAULT ${expr}`,
    risk: "SAFE",
    table,
    column: col.name,
  });
  push(steps, {
    kind: "cutover",
    sql:
      `DROP TRIGGER IF EXISTS ${fn} ON ${r};\n` +
      `DROP FUNCTION IF EXISTS gitdb.${fn}()`,
    risk: "SAFE",
    table,
    column: col.name,
  });
}

function compileOp(steps: MigrationStep[], ctx: PlanCtx, op: SchemaOp): void {
  const risk = classify(op);
  const schema = ctx.schema ?? MAIN_SCHEMA;

  switch (op.kind) {
    case "create_table":
      push(steps, { kind: "ddl", sql: createTableSQL(schema, op.table), risk, table: op.table.name });
      return;
    case "drop_table":
      push(steps, {
        kind: "contract",
        sql: `DROP TABLE ${rel(ctx, op.table)}`,
        risk,
        manual: true,
        table: op.table,
      });
      return;
    case "add_column": {
      if (defaultIsVolatile(op.column.default)) {
        rewriteVolatileAdd(steps, ctx, op);
        return;
      }
      const parts = [
        `ALTER TABLE ${rel(ctx, op.table)} ADD COLUMN ${ident(op.column.name)} ${assertTypeExpr(op.column.type)}`,
      ];
      if (op.column.default) parts[0] += ` DEFAULT ${op.column.default}`;
      if (!op.column.nullable) parts[0] += " NOT NULL";
      push(steps, { kind: "ddl", sql: parts[0]!, risk, table: op.table, column: op.column.name });
      return;
    }
    case "drop_column":
      push(steps, {
        kind: "contract",
        sql: `ALTER TABLE ${rel(ctx, op.table)} DROP COLUMN ${ident(op.column)}`,
        risk,
        manual: true,
        table: op.table,
        column: op.column,
      });
      return;
    case "rename_column":
      push(steps, {
        kind: "ddl",
        sql: `ALTER TABLE ${rel(ctx, op.table)} RENAME COLUMN ${ident(op.from)} TO ${ident(op.to)}`,
        risk,
        table: op.table,
        column: op.to,
      });
      return;
    case "retype_column":
      if (isBinaryCoercible(op.from, op.to)) {
        const using = op.using ? ` USING ${op.using}` : "";
        push(steps, {
          kind: "ddl",
          sql: `ALTER TABLE ${rel(ctx, op.table)} ALTER COLUMN ${ident(op.column)} TYPE ${assertTypeExpr(op.to)}${using}`,
          risk,
          table: op.table,
          column: op.column,
        });
        return;
      }
      rewriteRetype(steps, ctx, op);
      return;
    case "set_nullable":
      if (op.nullable) {
        push(steps, {
          kind: "ddl",
          sql: `ALTER TABLE ${rel(ctx, op.table)} ALTER COLUMN ${ident(op.column)} DROP NOT NULL`,
          risk,
          table: op.table,
          column: op.column,
        });
      } else {
        addNotNullPipeline(steps, ctx, op.table, op.column);
      }
      return;
    case "set_default":
      push(steps, {
        kind: "ddl",
        sql:
          op.default == null
            ? `ALTER TABLE ${rel(ctx, op.table)} ALTER COLUMN ${ident(op.column)} DROP DEFAULT`
            : `ALTER TABLE ${rel(ctx, op.table)} ALTER COLUMN ${ident(op.column)} SET DEFAULT ${op.default}`,
        risk,
        table: op.table,
        column: op.column,
      });
      return;
    case "drop_constraint":
      push(steps, {
        kind: "ddl",
        sql: `ALTER TABLE ${rel(ctx, op.table)} DROP CONSTRAINT ${ident(op.constraint)}`,
        risk,
        table: op.table,
      });
      return;
    case "add_constraint": {
      const r = rel(ctx, op.table);
      const name = ident(op.constraint.name);
      if (op.constraint.kind === "check") {
        const expr = op.constraint.expression;
        if (!expr) throw new Error(`check constraint ${op.constraint.name} has no expression`);
        push(steps, {
          kind: "ddl",
          sql: `ALTER TABLE ${r} ADD CONSTRAINT ${name} CHECK (${expr}) NOT VALID`,
          risk,
          table: op.table,
        });
        push(steps, { kind: "validate", sql: `ALTER TABLE ${r} VALIDATE CONSTRAINT ${name}`, risk, table: op.table });
        return;
      }
      if (op.constraint.kind === "foreign") {
        const ref = op.constraint.references;
        if (!ref) throw new Error(`foreign constraint ${op.constraint.name} has no references`);
        const cols = op.constraint.columns.map(ident).join(", ");
        const rcols = ref.columns.map(ident).join(", ");
        push(steps, {
          kind: "ddl",
          sql: `ALTER TABLE ${r} ADD CONSTRAINT ${name} FOREIGN KEY (${cols}) REFERENCES ${qname(schema, ref.table)} (${rcols}) NOT VALID`,
          risk,
          table: op.table,
        });
        push(steps, { kind: "validate", sql: `ALTER TABLE ${r} VALIDATE CONSTRAINT ${name}`, risk, table: op.table });
        return;
      }
      // unique / primary: unique index concurrently, then USING INDEX
      const cols = op.constraint.columns.map(ident).join(", ");
      const idxName = ident(`${op.constraint.name}_idx`);
      push(steps, {
        kind: "index_concurrent",
        sql: `CREATE UNIQUE INDEX CONCURRENTLY ${idxName} ON ${r} (${cols})`,
        risk,
        table: op.table,
        index: `${op.constraint.name}_idx`,
      });
      push(steps, {
        kind: "ddl",
        sql: `ALTER TABLE ${r} ADD CONSTRAINT ${name} ${op.constraint.kind === "primary" ? "PRIMARY KEY" : "UNIQUE"} USING INDEX ${idxName}`,
        risk,
        table: op.table,
      });
      return;
    }
    case "drop_index":
      push(steps, {
        kind: "ddl",
        sql: `DROP INDEX ${qname(schema, op.index)}`,
        risk,
        table: op.table,
      });
      return;
    case "add_index": {
      const r = rel(ctx, op.table);
      const cols = op.index.columns.map(ident).join(", ");
      const pred = op.index.predicate ? ` WHERE ${op.index.predicate}` : "";
      const unique = op.index.unique ? " UNIQUE" : "";
      push(steps, {
        kind: "index_concurrent",
        sql: `CREATE${unique} INDEX CONCURRENTLY ${ident(op.index.name)} ON ${r} USING ${op.index.method} (${cols})${pred}`,
        risk,
        table: op.table,
        index: op.index.name,
      });
      return;
    }
  }
}

/** Compile SchemaOp[] into ordered, persistable migration steps. CONTRACT steps are manual. */
export function compilePlan(ops: SchemaOp[], ctx: PlanCtx): MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (const op of ops) compileOp(steps, ctx, op);
  return steps.map((s, seq) => ({ ...s, seq }));
}
