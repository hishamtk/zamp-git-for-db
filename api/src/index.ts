import { pathToFileURL } from "node:url";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { closeAll, sql } from "./db.js";
import { ContractBlocked, RevertRefused } from "./engine/contract.js";
import { InvalidIdentifier } from "./ident.js";
import { UnsupportedDDL } from "./ir/parse.js";
import { branchRoutes } from "./routes/branches.js";
import { diffRoutes } from "./routes/diff.js";
import { mergeRoutes } from "./routes/merges.js";
import { systemRoutes } from "./routes/system.js";
import { BranchError } from "./vcs/branches.js";
import { bootstrap } from "./vcs/commits.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    const custom = error as Error & {
      status?: number;
      statusCode?: number;
      code?: string;
      payload?: Record<string, unknown>;
    };
    if (custom.payload) return reply.code(custom.statusCode ?? 400).send(custom.payload);
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", message: error.issues[0]?.message, issues: error.issues });
    }
    if (error instanceof BranchError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error instanceof InvalidIdentifier || error instanceof UnsupportedDDL) {
      return reply.code(400).send({ error: error.name, message: error.message });
    }
    if (error instanceof ContractBlocked) {
      return reply.code(409).send({ state: "contract_blocked", branches: error.branches, message: error.message });
    }
    if (error instanceof RevertRefused) {
      return reply.code(409).send({ state: "revert_refused", message: error.message });
    }
    const status = custom.statusCode ?? custom.status ?? 500;
    if (status >= 500) app.log.error(error);
    return reply.code(status).send({ error: custom.code ?? "internal_error", message: custom.message });
  });

  await bootstrap(sql);
  await app.register(systemRoutes);
  await app.register(branchRoutes);
  await app.register(diffRoutes);
  await app.register(mergeRoutes);
  return app;
}

async function start(): Promise<void> {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
  const shutdown = async () => {
    await app.close();
    await closeAll();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
