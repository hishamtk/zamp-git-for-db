/**
 * Not a unit test - a manual probe against the live seeded database.
 * Run: npx tsx api/test/introspect.probe.ts
 */
import { sql, closeAll } from "../src/db.js";
import { introspect } from "../src/ir/introspect.js";
import { canonicalJSON, hashIR } from "../src/ir/canonical.js";
import { sortIR } from "../src/ir/types.js";

const { ir, unsupported } = await introspect(sql, "main");

console.log("\n=== tables ===");
for (const t of ir.tables) {
  console.log(`\n${t.name}`);
  for (const c of t.columns) {
    console.log(
      `   ${c.name.padEnd(14)} ${c.type.padEnd(28)} ${c.nullable ? "NULL" : "NOT NULL"}` +
        (c.default ? `  default=${c.default}` : ""),
    );
  }
  for (const k of t.constraints) console.log(`   [c] ${k.name} ${k.kind} (${k.columns.join(",")}) validated=${k.validated}`);
  for (const i of t.indexes) console.log(`   [i] ${i.name} ${i.unique ? "UNIQUE " : ""}(${i.columns.join(",")})`);
}

console.log("\n=== unsupported ===");
console.log(unsupported.length ? unsupported : "  (none)");

console.log("\n=== hash stability ===");
const h1 = hashIR(ir);
const h2 = hashIR((await introspect(sql, "main")).ir);
console.log(`  h1 === h2 : ${h1 === h2 ? "PASS" : "FAIL"}  (${h1.slice(0, 16)}...)`);

console.log("\n=== column order is not semantic ===");
const shuffled = structuredClone(ir);
shuffled.tables[0]!.columns.reverse();
shuffled.tables.reverse();
console.log(`  reordered hash equal : ${hashIR(shuffled) === h1 ? "PASS" : "FAIL"}`);

console.log("\n=== sortIR is idempotent ===");
console.log(`  ${canonicalJSON(sortIR(sortIR(ir))) === canonicalJSON(ir) ? "PASS" : "FAIL"}`);

console.log("\n=== type canonicalisation (varchar spellings must agree) ===");
await sql`DROP TABLE IF EXISTS main._canon_a, main._canon_b`;
await sql`CREATE TABLE main._canon_a (a varchar(255), b integer, c timestamptz, d numeric(20,2), e char(2))`;
await sql`CREATE TABLE main._canon_b (a character varying(255), b int, c timestamp with time zone, d decimal(20,2), e character(2))`;
const probe = (await introspect(sql, "main")).ir;
const A = probe.tables.find((t) => t.name === "_canon_a")!;
const B = probe.tables.find((t) => t.name === "_canon_b")!;
for (const col of ["a", "b", "c", "d", "e"]) {
  const ta = A.columns.find((c) => c.name === col)!.type;
  const tb = B.columns.find((c) => c.name === col)!.type;
  console.log(`  ${col}: ${ta.padEnd(30)} ${ta === tb ? "== PASS" : `!= FAIL (${tb})`}`);
}
await sql`DROP TABLE main._canon_a, main._canon_b`;

await closeAll();
