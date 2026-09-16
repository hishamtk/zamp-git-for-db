import { isBinaryCoercible } from "../ir/typecanon.js";
import type { SchemaOp } from "./diff.js";

export type Risk = "SAFE" | "LOCKING" | "REWRITE";

/**
 * Functions/keywords that rewrite a table when used as ADD COLUMN DEFAULT.
 * Unknown function calls are treated as volatile too — fail safe.
 */
const VOLATILE_FUNCS = new Set([
  "now",
  "clock_timestamp",
  "statement_timestamp",
  "transaction_timestamp",
  "timeofday",
  "current_timestamp",
  "current_date",
  "current_time",
  "localtimestamp",
  "localtime",
  "current_user",
  "session_user",
  "user",
  "current_role",
  "random",
  "gen_random_uuid",
  "uuid_generate_v4",
  "uuidv4",
  "uuidv7",
  "nextval",
  "currval",
  "setval",
  "txid_current",
  "pg_backend_pid",
]);

const VOLATILE_BARE = new Set([
  "current_timestamp",
  "current_date",
  "current_time",
  "localtimestamp",
  "localtime",
  "current_user",
  "session_user",
  "user",
  "current_role",
]);

/** True when a DEFAULT expression would force a full table rewrite on ADD COLUMN. */
export function defaultIsVolatile(expr: string | null): boolean {
  if (expr == null) return false;
  const stripped = expr
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/::[a-zA-Z_][\w.]*(?:\([^)]*\))?/g, " ")
    .toLowerCase();

  for (const name of VOLATILE_BARE) {
    if (new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`).test(stripped)) return true;
  }

  for (const m of stripped.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
    const fn = m[1]!;
    if (fn === "cast") continue;
    // Any remaining function call: listed volatile or unknown → rewrite.
    void VOLATILE_FUNCS;
    return true;
  }
  return false;
}

export function classify(op: SchemaOp): Risk {
  switch (op.kind) {
    case "add_column": {
      if (defaultIsVolatile(op.column.default)) return "REWRITE";
      return "SAFE";
    }
    case "retype_column":
      return isBinaryCoercible(op.from, op.to) ? "SAFE" : "REWRITE";
    case "set_nullable":
      return op.nullable ? "SAFE" : "LOCKING";
    case "add_index":
    case "add_constraint":
      return "LOCKING";
    case "create_table":
    case "drop_table":
    case "drop_column":
    case "rename_column":
    case "set_default":
    case "drop_constraint":
    case "drop_index":
      return "SAFE";
  }
}
