import { describe, expect, it } from "vitest";
import { diff } from "../src/diff/diff.js";
import type { Column, Constraint, Index, SchemaIR, Table } from "../src/ir/types.js";
import { sortIR } from "../src/ir/types.js";

function column(name: string, overrides: Partial<Column> = {}): Column {
  return {
    name,
    physicalName: name,
    type: "pg_catalog.int8",
    nullable: true,
    default: null,
    ordinal: 1,
    ...overrides,
    name: overrides.name ?? name,
  };
}

function pk(table: string, col = "id"): Constraint {
  return {
    name: `${table}_pkey`,
    kind: "primary",
    columns: [col],
    expression: null,
    references: null,
    validated: true,
  };
}

function index(name: string, columns: string[], overrides: Partial<Index> = {}): Index {
  return {
    name,
    columns,
    unique: false,
    method: "btree",
    predicate: null,
    ...overrides,
    name: overrides.name ?? name,
  };
}

function table(name: string, overrides: Partial<Table> = {}): Table {
  return {
    name,
    columns: [column("id", { nullable: false })],
    constraints: [],
    indexes: [],
    ...overrides,
    name,
  };
}

function ir(...tables: Table[]): SchemaIR {
  return { version: 1, tables };
}

const txns: Table = table("txns", {
  columns: [
    column("id", { nullable: false, ordinal: 1 }),
    column("amount_cents", { nullable: false, ordinal: 2 }),
    column("memo", { type: "pg_catalog.text", ordinal: 3 }),
  ],
  constraints: [pk("txns")],
  indexes: [index("txns_memo_idx", ["memo"])],
});

describe("diff — no-ops", () => {
  it("identical IRs produce []", () => {
    expect(diff(ir(txns), ir(structuredClone(txns)))).toEqual([]);
  });

  it("two empty IRs produce []", () => {
    expect(diff({ version: 1, tables: [] }, { version: 1, tables: [] })).toEqual([]);
  });

  it("reordered columns produce []", () => {
    const shuffled = structuredClone(txns);
    shuffled.columns.reverse();
    expect(diff(ir(txns), ir(shuffled))).toEqual([]);
  });

  it("reordered tables produce []", () => {
    const a = table("accounts");
    expect(diff(ir(txns, a), ir(a, txns))).toEqual([]);
  });

  it("ordinal-only change produces []", () => {
    const moved = structuredClone(txns);
    moved.columns[1]!.ordinal = 99;
    expect(diff(ir(txns), ir(moved))).toEqual([]);
  });

  it("physicalName-only change produces []", () => {
    const moved = structuredClone(txns);
    moved.columns[1]!.physicalName = "amount_cents_old";
    expect(diff(ir(txns), ir(moved))).toEqual([]);
  });

  it("varchar(255) vs character varying(255) produce []", () => {
    const a = table("t", {
      columns: [column("name", { type: "varchar(255)" })],
    });
    const b = table("t", {
      columns: [column("name", { type: "character varying(255)" })],
    });
    expect(diff(ir(a), ir(b))).toEqual([]);
  });

  it("int / integer / pg_catalog.int4 produce []", () => {
    const a = table("t", { columns: [column("n", { type: "int" })] });
    const b = table("t", { columns: [column("n", { type: "integer" })] });
    const c = table("t", { columns: [column("n", { type: "pg_catalog.int4" })] });
    expect(diff(ir(a), ir(b))).toEqual([]);
    expect(diff(ir(b), ir(c))).toEqual([]);
  });
});

describe("diff — tables", () => {
  it("create_table emits the whole table and no nested add_* ops", () => {
    const extra = table("accounts", {
      columns: [column("id", { nullable: false }), column("email", { type: "pg_catalog.text" })],
      constraints: [pk("accounts")],
      indexes: [index("accounts_email_idx", ["email"])],
    });
    const ops = diff(ir(txns), ir(txns, extra));
    expect(ops).toEqual([{ kind: "create_table", table: sortIR(ir(extra)).tables[0] }]);
  });

  it("drop_table does not emit drop_column / drop_index / drop_constraint", () => {
    const ops = diff(ir(txns), ir());
    expect(ops).toEqual([{ kind: "drop_table", table: "txns" }]);
  });
});

describe("diff — columns", () => {
  it("add_column", () => {
    const next = structuredClone(txns);
    const status = column("status", { type: "pg_catalog.text", nullable: false, ordinal: 4 });
    next.columns.push(status);
    expect(diff(ir(txns), ir(next))).toEqual([{ kind: "add_column", table: "txns", column: status }]);
  });

  it("drop_column", () => {
    const next = structuredClone(txns);
    next.columns = next.columns.filter((c) => c.name !== "memo");
    expect(diff(ir(txns), ir(next))).toEqual([{ kind: "drop_column", table: "txns", column: "memo" }]);
  });

  it("rename_column when physicalName still points at the old column", () => {
    const next = structuredClone(txns);
    const col = next.columns.find((c) => c.name === "amount_cents")!;
    col.name = "amount";
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "rename_column", table: "txns", from: "amount_cents", to: "amount" },
    ]);
  });

  it("genuine drop+add (no physicalName link) is not a rename", () => {
    const next = structuredClone(txns);
    next.columns = next.columns.filter((c) => c.name !== "memo");
    const notes = column("notes", { type: "pg_catalog.text", ordinal: 3 });
    next.columns.push(notes);
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "drop_column", table: "txns", column: "memo" },
      { kind: "add_column", table: "txns", column: notes },
    ]);
  });

  it("retype_column", () => {
    const next = structuredClone(txns);
    next.columns.find((c) => c.name === "amount_cents")!.type = "pg_catalog.numeric(20,2)";
    expect(diff(ir(txns), ir(next))).toEqual([
      {
        kind: "retype_column",
        table: "txns",
        column: "amount_cents",
        from: "pg_catalog.int8",
        to: "pg_catalog.numeric(20,2)",
      },
    ]);
  });

  it("set_nullable true (drop NOT NULL)", () => {
    const next = structuredClone(txns);
    next.columns.find((c) => c.name === "amount_cents")!.nullable = true;
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "set_nullable", table: "txns", column: "amount_cents", nullable: true },
    ]);
  });

  it("set_nullable false (set NOT NULL)", () => {
    const next = structuredClone(txns);
    next.columns.find((c) => c.name === "memo")!.nullable = false;
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "set_nullable", table: "txns", column: "memo", nullable: false },
    ]);
  });

  it("set_default", () => {
    const next = structuredClone(txns);
    next.columns.find((c) => c.name === "memo")!.default = "'n/a'::text";
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "set_default", table: "txns", column: "memo", default: "'n/a'::text" },
    ]);
  });

  it("clear default", () => {
    const from = structuredClone(txns);
    from.columns.find((c) => c.name === "memo")!.default = "'n/a'::text";
    expect(diff(ir(from), ir(txns))).toEqual([
      { kind: "set_default", table: "txns", column: "memo", default: null },
    ]);
  });

  it("rename plus retype emits both, retype uses the new name", () => {
    const next = structuredClone(txns);
    const col = next.columns.find((c) => c.name === "amount_cents")!;
    col.name = "amount";
    col.type = "pg_catalog.numeric(20,2)";
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "rename_column", table: "txns", from: "amount_cents", to: "amount" },
      {
        kind: "retype_column",
        table: "txns",
        column: "amount",
        from: "pg_catalog.int8",
        to: "pg_catalog.numeric(20,2)",
      },
    ]);
  });

  it("retype + nullability + default on one column emit three ops", () => {
    const next = structuredClone(txns);
    const col = next.columns.find((c) => c.name === "memo")!;
    col.type = "pg_catalog.varchar(40)";
    col.nullable = false;
    col.default = "''::character varying";
    expect(diff(ir(txns), ir(next))).toEqual([
      {
        kind: "retype_column",
        table: "txns",
        column: "memo",
        from: "pg_catalog.text",
        to: "pg_catalog.varchar(40)",
      },
      { kind: "set_nullable", table: "txns", column: "memo", nullable: false },
      { kind: "set_default", table: "txns", column: "memo", default: "''::character varying" },
    ]);
  });
});

describe("diff — constraints and indexes", () => {
  it("add_constraint", () => {
    const check: Constraint = {
      name: "txns_amount_positive",
      kind: "check",
      columns: ["amount_cents"],
      expression: "amount_cents > 0",
      references: null,
      validated: true,
    };
    const next = structuredClone(txns);
    next.constraints.push(check);
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "add_constraint", table: "txns", constraint: check },
    ]);
  });

  it("add_constraint foreign", () => {
    const fk: Constraint = {
      name: "txns_account_fk",
      kind: "foreign",
      columns: ["id"],
      expression: null,
      references: { table: "accounts", columns: ["id"] },
      validated: false,
    };
    const next = structuredClone(txns);
    next.constraints.push(fk);
    expect(diff(ir(txns), ir(next))).toEqual([{ kind: "add_constraint", table: "txns", constraint: fk }]);
  });

  it("drop_constraint", () => {
    const next = structuredClone(txns);
    next.constraints = [];
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "drop_constraint", table: "txns", constraint: "txns_pkey" },
    ]);
  });

  it("constraint definition change is drop + add, not a dedicated op", () => {
    const next = structuredClone(txns);
    next.constraints[0] = { ...pk("txns"), columns: ["id", "amount_cents"] };
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "drop_constraint", table: "txns", constraint: "txns_pkey" },
      { kind: "add_constraint", table: "txns", constraint: next.constraints[0] },
    ]);
  });

  it("validated-only change produces [] (no SchemaOp for VALIDATE)", () => {
    const next = structuredClone(txns);
    next.constraints[0]!.validated = false;
    expect(diff(ir(txns), ir(next))).toEqual([]);
  });

  it("add_index", () => {
    const idx = index("txns_amount_idx", ["amount_cents"]);
    const next = structuredClone(txns);
    next.indexes.push(idx);
    expect(diff(ir(txns), ir(next))).toEqual([{ kind: "add_index", table: "txns", index: idx }]);
  });

  it("drop_index", () => {
    const next = structuredClone(txns);
    next.indexes = [];
    expect(diff(ir(txns), ir(next))).toEqual([{ kind: "drop_index", table: "txns", index: "txns_memo_idx" }]);
  });

  it("index definition change is drop + add", () => {
    const next = structuredClone(txns);
    next.indexes[0] = index("txns_memo_idx", ["memo"], { predicate: "memo IS NOT NULL" });
    expect(diff(ir(txns), ir(next))).toEqual([
      { kind: "drop_index", table: "txns", index: "txns_memo_idx" },
      { kind: "add_index", table: "txns", index: next.indexes[0] },
    ]);
  });
});

describe("diff — ordering", () => {
  it("emits drop_table, then table ops, then create_table, tables sorted by name", () => {
    const from = ir(
      table("zebra"),
      table("keep", { columns: [column("id", { nullable: false })] }),
    );
    const toKeep = table("keep", {
      columns: [column("id", { nullable: false }), column("n")],
    });
    const to = ir(toKeep, table("apple"));
    const ops = diff(from, to);
    expect(ops.map((o) => o.kind)).toEqual(["drop_table", "add_column", "create_table"]);
    expect(ops[0]).toEqual({ kind: "drop_table", table: "zebra" });
    expect(ops[2]).toMatchObject({ kind: "create_table", table: { name: "apple" } });
  });

  it("within a table, drops then renames then alters then adds", () => {
    const from = table("t", {
      columns: [
        column("id", { nullable: false }),
        column("old_name"),
        column("gone", { type: "pg_catalog.text" }),
        column("typed", { type: "pg_catalog.int4" }),
      ],
      constraints: [pk("t")],
      indexes: [index("t_gone_idx", ["gone"])],
    });
    const to = table("t", {
      columns: [
        column("id", { nullable: false }),
        column("new_name", { physicalName: "old_name" }),
        column("typed", { type: "pg_catalog.int8" }),
        column("fresh", { type: "pg_catalog.text" }),
      ],
      constraints: [
        pk("t"),
        {
          name: "t_check",
          kind: "check",
          columns: ["typed"],
          expression: "typed > 0",
          references: null,
          validated: true,
        },
      ],
      indexes: [index("t_fresh_idx", ["fresh"])],
    });
    expect(diff(ir(from), ir(to)).map((o) => o.kind)).toEqual([
      "drop_index",
      "drop_column",
      "rename_column",
      "retype_column",
      "add_column",
      "add_constraint",
      "add_index",
    ]);
  });
});
