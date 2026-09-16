import type { Sql } from "../db.js";
import { qname } from "../ident.js";
import { introspect } from "../ir/introspect.js";
import { cloneIR, findTable, type SchemaIR, type Table } from "../ir/types.js";
import { requireCommit } from "../vcs/commits.js";
import { createViewSQL } from "./views.js";
import { guardedDDL, type Emit } from "./guarded.js";

type BranchRow = {
  name: string;
  schema_name: string;
  head_commit: string | null;
};

type DependentView = {
  schema_name: string;
  view_name: string;
  depth: number;
};

export class UnknownDependentView extends Error {
  constructor(readonly views: string[]) {
    super(`DDL blocked by views not owned by gitdb: ${views.join(", ")}`);
    this.name = "UnknownDependentView";
  }
}

async function dependentViews(sql: Sql, schema: string, table: string): Promise<DependentView[]> {
  return sql<DependentView[]>`
    WITH RECURSIVE view_deps AS (
      SELECT vn.nspname::text AS schema_name, v.relname::text AS view_name,
             v.oid AS view_oid, 1 AS depth, ARRAY[v.oid] AS path
        FROM pg_depend d
        JOIN pg_rewrite rw ON rw.oid = d.objid
        JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v'
        JOIN pg_namespace vn ON vn.oid = v.relnamespace
       WHERE d.refobjid = ${qname(schema, table)}::regclass
      UNION
      SELECT vn.nspname::text, v.relname::text, v.oid, vd.depth + 1,
             vd.path || v.oid
        FROM view_deps vd
        JOIN pg_depend d ON d.refobjid = vd.view_oid
        JOIN pg_rewrite rw ON rw.oid = d.objid
        JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind = 'v'
        JOIN pg_namespace vn ON vn.oid = v.relnamespace
       WHERE NOT v.oid = ANY(vd.path)
    )
    SELECT schema_name, view_name, max(depth)::int AS depth
      FROM view_deps
     GROUP BY schema_name, view_name
     ORDER BY depth DESC, schema_name, view_name`;
}

function remapTable(branch: Table, oldParent: Table, newParent: Table): { table?: Table; stale?: string } {
  const out = structuredClone(branch);
  const oldNames = new Set(oldParent.columns.map((column) => column.name));
  const newNames = new Set(newParent.columns.map((column) => column.name));

  for (const column of out.columns) {
    if (newNames.has(column.physicalName) || !oldNames.has(column.physicalName)) continue;

    const sameLogical = newParent.columns.find(
      (candidate) => candidate.name === column.name && candidate.type === column.type,
    );
    const backups = newParent.columns.filter(
      (candidate) =>
        candidate.name.startsWith(`${column.physicalName}__old_`) &&
        candidate.type === column.type,
    );
    const replacement = sameLogical ?? (backups.length === 1 ? backups[0] : undefined);
    if (!replacement) {
      return {
        stale: `stale: main dropped \`${column.physicalName}\`, which this branch references.`,
      };
    }
    column.physicalName = replacement.name;
  }
  return { table: out };
}

/**
 * Execute DDL while temporarily removing every registered dependent branch view.
 * The drop, DDL, recreation, and stale markers are one guarded transaction.
 */
export async function guardedDDLWithViews(
  sql: Sql,
  opts: { ddl: string; schema?: string; table: string; emit: Emit },
): Promise<void> {
  const schema = opts.schema ?? "main";
  const [branches, deps, oldParent] = await Promise.all([
    sql<BranchRow[]>`
      SELECT name, schema_name, head_commit
        FROM gitdb.branches
       WHERE name <> 'main'
       ORDER BY name`,
    dependentViews(sql, schema, opts.table),
    introspect(sql, schema).then((result) => result.ir),
  ]);

  const bySchema = new Map(branches.map((branch) => [branch.schema_name, branch]));
  const unknown = deps.filter((dep) => !bySchema.has(dep.schema_name));
  if (unknown.length) {
    throw new UnknownDependentView(unknown.map((dep) => qname(dep.schema_name, dep.view_name)));
  }

  const branchIRs = new Map<string, SchemaIR>();
  for (const branch of branches) {
    const ir = (await introspect(sql, branch.schema_name)).ir;
    branchIRs.set(branch.schema_name, cloneIR(ir));
  }

  await guardedDDL(sql, opts.ddl, opts.emit, undefined, async (tx) => {
    for (const dep of deps) {
      await tx.unsafe(`DROP VIEW ${qname(dep.schema_name, dep.view_name)}`);
    }

    await tx.unsafe(opts.ddl);
    const newParentIR = (await introspect(tx, schema)).ir;
    const oldParentTable = findTable(oldParent, opts.table);
    const newParentTable = findTable(newParentIR, opts.table);

    for (const dep of [...deps].sort((a, b) => a.depth - b.depth)) {
      const branch = bySchema.get(dep.schema_name)!;
      const branchIR = branchIRs.get(dep.schema_name)!;
      const branchTable = findTable(branchIR, dep.view_name);
      const oldTable = findTable(oldParent, dep.view_name);
      const newTable = findTable(newParentIR, dep.view_name);

      if (!branchTable || !oldTable || !newTable) {
        const reason = `stale: main dropped \`${dep.view_name}\`, which this branch references.`;
        await tx`UPDATE gitdb.branches SET stale_reason = ${reason} WHERE name = ${branch.name}`;
        continue;
      }

      const mapped =
        dep.view_name === opts.table && oldParentTable && newParentTable
          ? remapTable(branchTable, oldParentTable, newParentTable)
          : { table: branchTable };
      if (!mapped.table) {
        await tx`
          UPDATE gitdb.branches
             SET stale_reason = ${mapped.stale!}
           WHERE name = ${branch.name}`;
        continue;
      }

      await tx.unsafe(createViewSQL(dep.schema_name, mapped.table, newTable, schema));
      await tx`UPDATE gitdb.branches SET stale_reason = NULL WHERE name = ${branch.name}`;
    }
  });
}

/** Return committed branch IR when a dropped view prevents live introspection. */
export async function committedBranchIR(sql: Sql, branch: BranchRow): Promise<SchemaIR | null> {
  if (!branch.head_commit) return null;
  return (await requireCommit(sql, branch.head_commit)).ir;
}
