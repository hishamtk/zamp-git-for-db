/** Manual probe: npx tsx api/test/branch.probe.ts */
import { sql, closeAll } from "../src/db.js";
import { bootstrap } from "../src/vcs/commits.js";
import { createBranch, deleteBranch, workingIR, applyIR, listBranches } from "../src/vcs/branches.js";
import { hashIR } from "../src/ir/canonical.js";
import { cloneIR } from "../src/ir/types.js";

const ms = async (label: string, fn: () => Promise<unknown>) => {
  const t = performance.now();
  const r = await fn();
  console.log(`  ${label.padEnd(46)} ${(performance.now() - t).toFixed(1)} ms`);
  return r;
};

await ms("bootstrap gitdb", () => bootstrap(sql));
await sql`DELETE FROM gitdb.branches WHERE name = 'probe'`.catch(() => {});
await sql.unsafe(`DROP SCHEMA IF EXISTS br_probe CASCADE`);

console.log("\n=== branch creation cost ===");
await ms("CREATE BRANCH probe (over seeded txns)", () => createBranch(sql, { name: "probe" }));

const [{ count }] = await sql`SELECT count(*)::int AS count FROM br_probe.txns`;
const [{ bytes }] = await sql`
  SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::bigint AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'br_probe'`;
console.log(`  rows visible in branch                         ${count.toLocaleString()}`);
console.log(`  bytes occupied by branch                       ${bytes}`);

console.log("\n=== branch is writable (auto-updatable views) ===");
const [{ is_updatable }] = await sql`
  SELECT is_updatable FROM information_schema.views
   WHERE table_schema='br_probe' AND table_name='txns'`;
console.log(`  information_schema.views.is_updatable          ${is_updatable}`);

console.log("\n=== schema drift via view rewrite ===");
const base = await workingIR(sql, "probe");
const next = cloneIR(base);
const txns = next.tables.find((t) => t.name === "txns")!;

// rename amount_cents -> amount, retype to numeric, add settled_at, drop memo
const amt = txns.columns.find((c) => c.name === "amount_cents")!;
amt.name = "amount";
amt.type = "pg_catalog.numeric(20,2)";
txns.columns = txns.columns.filter((c) => c.name !== "memo");
txns.columns.push({
  name: "settled_at",
  physicalName: "settled_at",
  type: "pg_catalog.timestamptz",
  nullable: true,
  default: null,
  ordinal: 99,
});

await ms("apply 4 schema changes to branch", () => applyIR(sql, "probe", next));

const drifted = await workingIR(sql, "probe");
const cols = drifted.tables.find((t) => t.name === "txns")!.columns.map((c) => `${c.name}:${c.type.replace("pg_catalog.", "")}`);
console.log(`  branch columns now: ${cols.join(", ")}`);

console.log("\n=== drifted branch still queries real data ===");
const rows = await sql`SELECT id, amount, settled_at FROM br_probe.txns WHERE id = 42`;
console.log(`  SELECT id, amount, settled_at WHERE id=42 ->`, rows[0]);

console.log("\n=== main is untouched ===");
const [mainCols] = await sql`
  SELECT count(*)::int AS n FROM pg_attribute
   WHERE attrelid = 'main.txns'::regclass AND attnum > 0 AND NOT attisdropped`;
console.log(`  main.txns still has ${mainCols.n} physical columns (expect 7)`);

console.log("\n=== predicate pushdown through the drifted view ===");
const plan = await sql.unsafe(`EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM br_probe.txns WHERE id = 9999`);
console.log("  " + plan.map((r: Record<string, string>) => r["QUERY PLAN"]).slice(0, 2).join("\n  "));

console.log("\n=== cleanup ===");
await ms("DROP BRANCH probe", () => deleteBranch(sql, "probe"));
console.log(`  branches remaining: ${(await listBranches(sql)).map((b) => b.name).join(", ")}`);

await closeAll();
