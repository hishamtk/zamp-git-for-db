import { parse } from "libpg-query";
import type { SchemaOp } from "../diff/diff.js";
import { qid } from "../ident.js";
import { canonicalFromParser } from "./typecanon.js";
import { cloneIR, findTable, sortIR, type Column, type Constraint, type SchemaIR, type Table } from "./types.js";

export class UnsupportedDDL extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDDL";
  }
}

type Node = Record<string, any>;

function str(node: Node): string {
  const value = node?.String?.sval;
  if (typeof value !== "string") throw new UnsupportedDDL("unsupported identifier");
  return value;
}

function relation(node: Node): string {
  if (node?.schemaname) throw new UnsupportedDDL("schema-qualified relations are not accepted");
  if (typeof node?.relname !== "string") throw new UnsupportedDDL("statement has no relation");
  return node.relname;
}

function typeName(node: Node): string {
  const names = (node?.names ?? []).map(str);
  const mods = (node?.typmods ?? []).map((m: Node) => {
    const n = m?.A_Const?.ival?.ival;
    if (typeof n !== "number") throw new UnsupportedDDL("only integer type modifiers are supported");
    return n;
  });
  return canonicalFromParser(names, mods, Boolean(node?.arrayBounds?.length));
}

function expr(node: Node): string {
  if (node?.A_Const) {
    const c = node.A_Const;
    if (c.isnull) return "NULL";
    if (c.ival) return String(c.ival.ival ?? 0);
    if (c.fval) return String(c.fval.fval);
    if (c.boolval) return c.boolval.boolval ? "TRUE" : "FALSE";
    if (c.sval) return `'${String(c.sval.sval).replaceAll("'", "''")}'`;
  }
  if (node?.ColumnRef) return node.ColumnRef.fields.map(str).map(qid).join(".");
  if (node?.FuncCall) {
    const fn = node.FuncCall.funcname.map(str).map(qid).join(".");
    return `${fn}(${(node.FuncCall.args ?? []).map(expr).join(", ")})`;
  }
  if (node?.TypeCast) return `${expr(node.TypeCast.arg)}::${typeName(node.TypeCast.typeName)}`;
  if (node?.A_Expr) {
    const a = node.A_Expr;
    const op = a.name.map(str).join(" ");
    if (!a.lexpr) return `${op} ${expr(a.rexpr)}`;
    return `${expr(a.lexpr)} ${op} ${expr(a.rexpr)}`;
  }
  if (node?.BoolExpr) {
    const op = node.BoolExpr.boolop === "AND_EXPR" ? " AND " : node.BoolExpr.boolop === "OR_EXPR" ? " OR " : " NOT ";
    return `(${(node.BoolExpr.args ?? []).map(expr).join(op)})`;
  }
  if (node?.NullTest) return `${expr(node.NullTest.arg)} ${node.NullTest.nulltesttype === "IS_NOT_NULL" ? "IS NOT NULL" : "IS NULL"}`;
  if (node?.SQLValueFunction) return String(node.SQLValueFunction.op).replace(/^SVFOP_/, "").replaceAll("_", " ");
  throw new UnsupportedDDL("unsupported expression in DDL");
}

function constraint(node: Node, fallback: string): Constraint {
  const kind = ({
    CONSTR_PRIMARY: "primary",
    CONSTR_UNIQUE: "unique",
    CONSTR_CHECK: "check",
    CONSTR_FOREIGN: "foreign",
  } as const)[node.contype as string];
  if (!kind) throw new UnsupportedDDL(`unsupported constraint type ${node.contype}`);
  const keys = (node.keys ?? []).map(str);
  const out: Constraint = {
    name: node.conname ?? fallback,
    kind,
    columns: keys,
    expression: null,
    references: null,
    validated: node.initially_valid !== false,
  };
  if (kind === "check") out.expression = expr(node.raw_expr);
  if (kind === "foreign") {
    out.references = {
      table: relation(node.pktable),
      columns: (node.pk_attrs ?? []).map(str),
    };
  }
  return out;
}

function column(node: Node, ordinal: number): Column {
  const constraints = (node.constraints ?? []).map((x: Node) => x.Constraint);
  const def = constraints.find((c: Node) => c.contype === "CONSTR_DEFAULT");
  return {
    name: node.colname,
    physicalName: node.colname,
    type: typeName(node.typeName),
    nullable: !constraints.some((c: Node) => c.contype === "CONSTR_NOTNULL" || c.contype === "CONSTR_PRIMARY"),
    default: def ? expr(def.raw_expr) : null,
    ordinal,
  };
}

function createTable(node: Node): Table {
  const name = relation(node.relation);
  const columns: Column[] = [];
  const constraints: Constraint[] = [];
  for (const item of node.tableElts ?? []) {
    if (item.ColumnDef) {
      const col = column(item.ColumnDef, columns.length + 1);
      columns.push(col);
      for (const wrapped of item.ColumnDef.constraints ?? []) {
        const c = wrapped.Constraint;
        if (!["CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_CHECK", "CONSTR_FOREIGN"].includes(c.contype)) continue;
        const parsed = constraint({ ...c, keys: c.keys ?? [{ String: { sval: col.name } }] }, `${name}_${col.name}_${c.contype.toLowerCase()}`);
        constraints.push(parsed);
      }
    } else if (item.Constraint) {
      constraints.push(constraint(item.Constraint, `${name}_constraint_${constraints.length + 1}`));
    } else {
      throw new UnsupportedDDL("unsupported CREATE TABLE element");
    }
  }
  return { name, columns, constraints, indexes: [] };
}

function statementOps(stmt: Node, ir: SchemaIR): SchemaOp[] {
  if (stmt.CreateStmt) return [{ kind: "create_table", table: createTable(stmt.CreateStmt) }];
  if (stmt.IndexStmt) {
    const n = stmt.IndexStmt;
    if (n.concurrent) throw new UnsupportedDDL("CONCURRENTLY is selected by the merge engine");
    const table = relation(n.relation);
    const columns = (n.indexParams ?? []).map((p: Node) => {
      if (!p.IndexElem?.name || p.IndexElem.expr) throw new UnsupportedDDL("expression indexes are not supported");
      return p.IndexElem.name as string;
    });
    return [{
      kind: "add_index",
      table,
      index: {
        name: n.idxname,
        columns,
        unique: Boolean(n.unique),
        method: "btree",
        predicate: n.whereClause ? expr(n.whereClause) : null,
      },
    }];
  }
  if (stmt.RenameStmt?.renameType === "OBJECT_COLUMN") {
    const n = stmt.RenameStmt;
    return [{ kind: "rename_column", table: relation(n.relation), from: n.subname, to: n.newname }];
  }
  if (stmt.DropStmt) {
    const n = stmt.DropStmt;
    const names = (n.objects ?? []).map((o: Node) => o.List.items.map(str));
    if (names.some((x: string[]) => x.length !== 1)) throw new UnsupportedDDL("schema-qualified names are not accepted");
    if (n.removeType === "OBJECT_TABLE") return names.map((x: string[]) => ({ kind: "drop_table", table: x[0]! }));
    if (n.removeType === "OBJECT_INDEX") {
      return names.map((x: string[]) => {
        const index = x[0]!;
        const table = ir.tables.find((t) => t.indexes.some((i) => i.name === index))?.name;
        if (!table) throw new UnsupportedDDL(`no such index: ${index}`);
        return { kind: "drop_index", table, index };
      });
    }
    throw new UnsupportedDDL(`unsupported DROP object ${n.removeType}`);
  }
  if (stmt.AlterTableStmt) {
    const n = stmt.AlterTableStmt;
    const table = relation(n.relation);
    return (n.cmds ?? []).map((wrapped: Node): SchemaOp => {
      const cmd = wrapped.AlterTableCmd;
      switch (cmd.subtype) {
        case "AT_AddColumn":
          return { kind: "add_column", table, column: column(cmd.def.ColumnDef, (findTable(ir, table)?.columns.length ?? 0) + 1) };
        case "AT_DropColumn":
          return { kind: "drop_column", table, column: cmd.name };
        case "AT_AlterColumnType":
          return {
            kind: "retype_column",
            table,
            column: cmd.name,
            from: findTable(ir, table)?.columns.find((c) => c.name === cmd.name)?.type ?? (() => { throw new UnsupportedDDL(`no such column: ${table}.${cmd.name}`); })(),
            to: typeName(cmd.def.ColumnDef.typeName),
            using: cmd.def.ColumnDef.raw_default ? expr(cmd.def.ColumnDef.raw_default) : undefined,
          };
        case "AT_SetNotNull":
          return { kind: "set_nullable", table, column: cmd.name, nullable: false };
        case "AT_DropNotNull":
          return { kind: "set_nullable", table, column: cmd.name, nullable: true };
        case "AT_ColumnDefault":
          return { kind: "set_default", table, column: cmd.name, default: cmd.def ? expr(cmd.def) : null };
        case "AT_AddConstraint":
          return { kind: "add_constraint", table, constraint: constraint(cmd.def.Constraint, `${table}_constraint`) };
        case "AT_DropConstraint":
          return { kind: "drop_constraint", table, constraint: cmd.name };
        default:
          throw new UnsupportedDDL(`unsupported ALTER TABLE operation ${cmd.subtype}`);
      }
    });
  }
  const kind = Object.keys(stmt)[0] ?? "unknown";
  throw new UnsupportedDDL(`${kind.replace(/Stmt$/, "").toUpperCase()} is not supported; only schema DDL is accepted`);
}

export function applySchemaOps(input: SchemaIR, ops: SchemaOp[]): SchemaIR {
  const ir = cloneIR(input);
  for (const op of ops) {
    const table = "table" in op && typeof op.table === "string" ? findTable(ir, op.table) : undefined;
    switch (op.kind) {
      case "create_table": ir.tables.push(op.table); break;
      case "drop_table": ir.tables = ir.tables.filter((t) => t.name !== op.table); break;
      case "add_column": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.columns.push(op.column); break;
      case "drop_column": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.columns = table.columns.filter((c) => c.name !== op.column); break;
      case "rename_column": {
        const c = table?.columns.find((x) => x.name === op.from);
        if (!c) throw new UnsupportedDDL(`no such column: ${op.table}.${op.from}`);
        c.name = op.to;
        break;
      }
      case "retype_column": {
        const c = table?.columns.find((x) => x.name === op.column);
        if (!c) throw new UnsupportedDDL(`no such column: ${op.table}.${op.column}`);
        c.type = op.to; break;
      }
      case "set_nullable": {
        const c = table?.columns.find((x) => x.name === op.column);
        if (!c) throw new UnsupportedDDL(`no such column: ${op.table}.${op.column}`);
        c.nullable = op.nullable; break;
      }
      case "set_default": {
        const c = table?.columns.find((x) => x.name === op.column);
        if (!c) throw new UnsupportedDDL(`no such column: ${op.table}.${op.column}`);
        c.default = op.default; break;
      }
      case "add_constraint": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.constraints.push(op.constraint); break;
      case "drop_constraint": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.constraints = table.constraints.filter((c) => c.name !== op.constraint); break;
      case "add_index": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.indexes.push(op.index); break;
      case "drop_index": if (!table) throw new UnsupportedDDL(`no such table: ${op.table}`); table.indexes = table.indexes.filter((i) => i.name !== op.index); break;
    }
  }
  return sortIR(ir);
}

export async function parseDDL(sql: string, base: SchemaIR): Promise<{ ops: SchemaOp[]; ir: SchemaIR }> {
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse(sql);
  } catch (error) {
    throw new UnsupportedDDL(`invalid SQL: ${(error as Error).message}`);
  }
  if (!parsed.stmts.length) throw new UnsupportedDDL("SQL is empty");
  let ir = base;
  const ops: SchemaOp[] = [];
  for (const wrapped of parsed.stmts) {
    const next = statementOps(wrapped.stmt as Node, ir);
    ir = applySchemaOps(ir, next);
    ops.push(...next);
  }
  return { ops, ir };
}
