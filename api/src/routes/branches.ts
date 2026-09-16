import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SchemaOp } from "../diff/diff.js";
import { sql } from "../db.js";
import { hashIR } from "../ir/canonical.js";
import { findTable } from "../ir/types.js";
import { applySchemaOps, parseDDL } from "../ir/parse.js";
import { assertBranchName, qname } from "../ident.js";
import {
  applyIR,
  createBranch,
  deleteBranch,
  listBranches,
  requireBranch,
  workingIR,
} from "../vcs/branches.js";
import { log, writeCommit } from "../vcs/commits.js";

const branchBody = z.object({
  name: z.string(),
  from: z.string().default("main"),
});
const ddlBody = z.union([
  z.object({ sql: z.string().min(1), ops: z.never().optional() }),
  z.object({ ops: z.array(z.object({ kind: z.string() }).passthrough()).min(1), sql: z.never().optional() }),
]);
const commitBody = z.object({ message: z.string().trim().min(1).max(500) });

function branchParam(request: { params: unknown }): string {
  const name = z.object({ name: z.string() }).parse(request.params).name;
  assertBranchName(name);
  return name;
}

export async function branchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/branches", async () => (await listBranches(sql)).map(({ working_ir: _workingIR, ...branch }) => branch));

  app.post("/api/branches", async (request, reply) => {
    const body = branchBody.parse(request.body);
    assertBranchName(body.name);
    assertBranchName(body.from);
    return reply.code(201).send(await createBranch(sql, body));
  });

  app.delete("/api/branches/:name", async (request, reply) => {
    await deleteBranch(sql, branchParam(request));
    return reply.code(204).send();
  });

  app.get("/api/branches/:name/schema", async (request) => {
    const ir = await workingIR(sql, branchParam(request));
    return { ir, hash: hashIR(ir) };
  });

  app.get("/api/branches/:name/stats", async (request) => {
    const branch = branchParam(request);
    const b = await requireBranch(sql, branch);
    const ir = await workingIR(sql, branch);
    const names = ir.tables.map((table) => table.name);
    const rows = names.length
      ? await sql<{ relname: string; schema_name: string; row_count: string; size_bytes: string }[]>`
          SELECT c.relname, n.nspname AS schema_name,
                 greatest(c.reltuples, 0)::bigint::text AS row_count,
                 pg_total_relation_size(c.oid)::text AS size_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname IN ('main', ${b.schema_name})
             AND c.relkind IN ('r', 'p')
             AND c.relname IN ${sql(names)}`
      : [];
    const byName = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.schema_name === b.schema_name || !byName.has(row.relname)) byName.set(row.relname, row);
    }
    return {
      rowCount: names.reduce((total, name) => total + Number(byName.get(name)?.row_count ?? 0), 0),
      // Branch views own no storage. New branch-local tables are included separately.
      sizeBytes: branch === "main"
        ? names.reduce((total, name) => total + Number(byName.get(name)?.size_bytes ?? 0), 0)
        : rows
            .filter((row) => row.schema_name === b.schema_name)
            .reduce((total, row) => total + Number(row.size_bytes), 0),
      exact: false,
    };
  });

  app.get("/api/branches/:name/tables/:table/rows", async (request) => {
    const branch = branchParam(request);
    const table = z.object({ table: z.string().min(1) }).parse(request.params).table;
    const { limit } = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(request.query);
    const b = await requireBranch(sql, branch);
    const ir = await workingIR(sql, branch);
    if (!findTable(ir, table)) {
      throw Object.assign(new Error(`no such table on branch '${branch}': ${table}`), {
        statusCode: 404,
        code: "no_such_table",
      });
    }

    // Relation names come from the introspected IR and are quoted at interpolation.
    // The transaction is explicitly read-only so this browser can never mutate data.
    return sql.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      const relation = qname(b.schema_name, table);
      const [rows, count] = await Promise.all([
        tx.unsafe(`SELECT * FROM ${relation} LIMIT $1`, [limit]),
        tx.unsafe(`SELECT count(*)::text AS count FROM ${relation}`),
      ]);
      return { rows, rowCount: Number(count[0]?.count ?? 0), limit };
    });
  });

  app.post("/api/branches/:name/ddl", async (request) => {
    const branch = branchParam(request);
    const body = ddlBody.parse(request.body);
    const current = await workingIR(sql, branch);
    const parsed = "sql" in body && body.sql
      ? await parseDDL(body.sql, current)
      : { ops: body.ops as SchemaOp[], ir: applySchemaOps(current, body.ops as SchemaOp[]) };
    await applyIR(sql, branch, parsed.ir);
    return { ir: parsed.ir, hash: hashIR(parsed.ir), ops: parsed.ops };
  });

  app.post("/api/branches/:name/commit", async (request) => {
    const branch = branchParam(request);
    const body = commitBody.parse(request.body);
    const b = await requireBranch(sql, branch);
    const ir = await workingIR(sql, branch);
    return writeCommit(sql, { branch, ir, message: body.message, parentId: b.head_commit });
  });

  app.get("/api/branches/:name/log", async (request) => {
    const branch = branchParam(request);
    await requireBranch(sql, branch);
    return log(sql, branch);
  });
}
