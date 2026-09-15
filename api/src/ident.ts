/**
 * Identifier quoting and validation.
 *
 * DDL cannot be parameterised, so every identifier reaching a SQL string is
 * interpolated. Everything here exists to make that safe: names are validated
 * against a whitelist pattern at the route boundary, and quoted with Postgres
 * `%I` semantics at the point of use.
 */

export class InvalidIdentifier extends Error {
  constructor(name: string, why: string) {
    super(`invalid identifier ${JSON.stringify(name)}: ${why}`);
    this.name = "InvalidIdentifier";
  }
}

/** Postgres `quote_ident` semantics: wrap in double quotes, double any inner quote. */
export function qid(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidIdentifier(String(name), "empty");
  }
  if (name.length > 63) {
    throw new InvalidIdentifier(name, "exceeds Postgres' 63-byte identifier limit");
  }
  if (name.includes("\0")) throw new InvalidIdentifier(name, "contains a null byte");
  return `"${name.replaceAll('"', '""')}"`;
}

/** Qualified reference, e.g. `"main"."txns"`. */
export function qname(schema: string, relation: string): string {
  return `${qid(schema)}.${qid(relation)}`;
}

const BRANCH_NAME = /^[a-z0-9][a-z0-9-]{0,38}$/;

export function assertBranchName(name: string): void {
  if (!BRANCH_NAME.test(name)) {
    throw new InvalidIdentifier(
      name,
      "branch names must be 1-39 chars of [a-z0-9-] and start with a letter or digit",
    );
  }
}

/** `feature-x` -> `br_feature_x` */
export function branchSchema(name: string): string {
  assertBranchName(name);
  return `br_${name.replaceAll("-", "_")}`;
}

export const MAIN_SCHEMA = "main";
export const META_SCHEMA = "gitdb";
export const MAIN_BRANCH = "main";

export function schemaForBranch(branch: string): string {
  return branch === MAIN_BRANCH ? MAIN_SCHEMA : branchSchema(branch);
}

/**
 * Types are emitted by our own canonicaliser, never by a user, but they still land
 * in DDL strings. Allow only the shapes we generate.
 */
const TYPE_EXPR = /^[a-zA-Z0-9_. ]+(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\[\])?$/;

export function assertTypeExpr(type: string): string {
  if (!TYPE_EXPR.test(type)) throw new InvalidIdentifier(type, "not a recognised type expression");
  return type;
}
