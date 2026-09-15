/**
 * Canonical type names.
 *
 * Two sources have to agree on a single spelling:
 *   1. the catalog, via `pg_type.typname` + `format_type()` modifiers
 *   2. user DDL, via libpg-query's parse tree
 *
 * If they disagree, `varchar(255)` and `character varying(255)` show up as a spurious
 * diff - the exact failure mode that motivates diffing the catalog rather than text.
 *
 * Canonical form is `pg_catalog.<internal name><modifiers>`, e.g.
 * `pg_catalog.int8`, `pg_catalog.varchar(255)`, `pg_catalog.numeric(20,2)`.
 *
 * Verified against libpg-query 17.7.4: `varchar(255)` and `character varying(255)`
 * both parse to `["pg_catalog","varchar"]`; `int` and `integer` both to
 * `["pg_catalog","int4"]`. Bare internal names (`int4`, `timestamptz`) are left
 * unqualified by the parser, which is what ALIAS below repairs.
 */

/** SQL spellings -> internal `pg_type.typname`. */
const ALIAS: Record<string, string> = {
  // integers
  bigint: "int8",
  int8: "int8",
  integer: "int4",
  int: "int4",
  int4: "int4",
  smallint: "int2",
  int2: "int2",
  bigserial: "int8",
  serial: "int4",
  smallserial: "int2",
  // floats / exact numerics
  "double precision": "float8",
  float8: "float8",
  real: "float4",
  float4: "float4",
  numeric: "numeric",
  decimal: "numeric",
  // strings
  "character varying": "varchar",
  varchar: "varchar",
  character: "bpchar",
  char: "bpchar",
  bpchar: "bpchar",
  text: "text",
  // temporal
  "timestamp with time zone": "timestamptz",
  timestamptz: "timestamptz",
  "timestamp without time zone": "timestamp",
  timestamp: "timestamp",
  "time with time zone": "timetz",
  timetz: "timetz",
  "time without time zone": "time",
  time: "time",
  date: "date",
  interval: "interval",
  // misc
  boolean: "bool",
  bool: "bool",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  bytea: "bytea",
  inet: "inet",
  cidr: "cidr",
  macaddr: "macaddr",
  money: "money",
  oid: "oid",
  xml: "xml",
};

const PG_CATALOG = "pg_catalog.";

/** Types whose modifier we keep. Everything else drops its typmod as non-semantic. */
const MOD_BEARING = new Set(["varchar", "bpchar", "numeric", "timestamp", "timestamptz", "time", "timetz", "interval", "bit", "varbit"]);

export function internalName(sqlName: string): string {
  const key = sqlName.trim().toLowerCase().replace(/\s+/g, " ");
  return ALIAS[key] ?? key;
}

/**
 * Build the canonical form from an internal typname and an optional modifier.
 * `mods` is the raw parenthesised text including brackets, e.g. `"(20,2)"`.
 */
export function canonicalType(typname: string, mods?: string | null, isArray = false): string {
  const base = internalName(typname);
  const keep = mods && MOD_BEARING.has(base) ? mods.replace(/\s+/g, "") : "";
  return `${PG_CATALOG}${base}${keep}${isArray ? "[]" : ""}`;
}

/**
 * Canonicalise catalog output.
 *
 * `typname` comes from `pg_type.typname` (already internal). `formatted` is
 * `format_type(atttypid, atttypmod)`, used only to recover the modifier, since
 * decoding `atttypmod` by hand differs per type family.
 *
 * `format_type` puts the modifier directly after the base name even when the name
 * has trailing words - `timestamp(3) with time zone` - so taking the first
 * parenthesised group is correct.
 */
export function canonicalFromCatalog(typname: string, formatted: string): string {
  const isArray = typname.startsWith("_") || formatted.endsWith("[]");
  const base = isArray && typname.startsWith("_") ? typname.slice(1) : typname;
  const m = /\(([^)]*)\)/.exec(formatted);
  return canonicalType(base, m ? `(${m[1]})` : null, isArray);
}

/**
 * Canonicalise a libpg-query `TypeName` node.
 *
 * `names` is the dotted path the parser produced, e.g. `["pg_catalog","varchar"]`
 * or `["timestamptz"]`. `typmods` carries integer modifiers as A_Const nodes.
 */
export function canonicalFromParser(names: string[], typmods: number[], isArray = false): string {
  const last = names[names.length - 1];
  if (!last) throw new Error("type node has no name");
  const mods = typmods.length ? `(${typmods.join(",")})` : null;
  return canonicalType(last, mods, isArray);
}

/**
 * Whether `from` -> `to` can be done without rewriting the table.
 *
 * Postgres skips the rewrite when the conversion is binary-coercible. The safe
 * subset we claim here:
 *   - identical types
 *   - varchar(n) -> text, and varchar(n) -> varchar(m) where m >= n or m is unbounded
 *   - bpchar(n) -> text
 *   - numeric(p,s) -> numeric (unconstrained)
 *
 * Anything not listed is treated as REWRITE. Defaulting to the expensive answer is
 * the right failure direction: a wrongly-cheap classification means an unexpected
 * 38-second exclusive lock in production.
 */
export function isBinaryCoercible(from: string, to: string): boolean {
  if (from === to) return true;

  const parse = (t: string) => {
    const m = /^pg_catalog\.([a-z0-9_]+)(?:\(([^)]*)\))?(\[\])?$/.exec(t);
    if (!m) return null;
    return {
      base: m[1]!,
      mods: m[2] ? m[2].split(",").map((x) => Number(x.trim())) : [],
      array: Boolean(m[3]),
    };
  };

  const a = parse(from);
  const b = parse(to);
  if (!a || !b || a.array !== b.array) return false;

  if ((a.base === "varchar" || a.base === "bpchar") && b.base === "text") return true;

  if (a.base === "varchar" && b.base === "varchar") {
    const an = a.mods[0];
    const bn = b.mods[0];
    if (bn === undefined) return true;          // widening to unbounded varchar
    if (an === undefined) return false;         // narrowing from unbounded
    return bn >= an;
  }

  if (a.base === "numeric" && b.base === "numeric" && b.mods.length === 0) return true;

  return false;
}
