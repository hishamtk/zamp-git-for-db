import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { classify } from "../diff/classify.js";
import { diffWithSuggestions } from "../diff/rename.js";
import type { SchemaIR } from "../ir/types.js";
import { getBranch, workingIR } from "../vcs/branches.js";
import { getCommit } from "../vcs/commits.js";

async function resolveRef(ref: string): Promise<SchemaIR> {
  if (await getBranch(sql, ref)) return workingIR(sql, ref);
  const commit = await getCommit(sql, ref);
  if (commit) return commit.ir;
  const error = new Error(`no such branch or commit: ${ref}`);
  Object.assign(error, { statusCode: 404, code: "no_such_ref" });
  throw error;
}

export async function diffRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/diff", async (request) => {
    const query = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(request.query);
    const [from, to] = await Promise.all([resolveRef(query.from), resolveRef(query.to)]);
    const result = diffWithSuggestions(from, to);
    return {
      ops: result.ops.map((op) => ({ ...op, risk: classify(op) })),
      renameSuggestions: result.renameSuggestions,
    };
  });
}
