#!/usr/bin/env node
/**
 * Seed the demo database.
 *
 *   main.txns      ~25M rows / ~5GB  - the credibility table
 *   main.accounts  ~200k rows / ~50MB - the fast path, so a reviewer can complete a
 *                                       full branch->diff->merge cycle in under a minute
 *
 * Measured on a 20-core NVMe box: 20M rows + 2 indexes in 80s, so 25M lands near 100s.
 *
 * The table is built UNLOGGED and switched to LOGGED afterwards. Skipping WAL for the
 * bulk load is most of the speedup; the SET LOGGED pass rewrites and WAL-logs once.
 *
 * Both tables are seeded with deliberate constraint violations - see VIOLATIONS below.
 */
import postgres from "postgres";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const ROWS = Number(String(args.rows ?? "25000000").replaceAll("_", ""));
const ACCOUNTS = Number(String(args.accounts ?? "200000").replaceAll("_", ""));
const URL = args.url ?? process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";
const CHUNK = 5_000_000;

const sql = postgres(URL, { max: 1, idle_timeout: 0, max_lifetime: 0, onnotice: () => {} });

const t0 = Date.now();
const step = async (label, fn) => {
  const s = Date.now();
  process.stdout.write(`  ${label} ... `);
  const r = await fn();
  console.log(`${((Date.now() - s) / 1000).toFixed(1)}s`);
  return r;
};

console.log(`\nSeeding ${URL.replace(/:[^:@]*@/, ":***@")}`);
console.log(`  txns=${ROWS.toLocaleString()} accounts=${ACCOUNTS.toLocaleString()}\n`);

await step("create schema main", async () => {
  await sql`CREATE SCHEMA IF NOT EXISTS main`;
  await sql`DROP TABLE IF EXISTS main.txns`;
  await sql`DROP TABLE IF EXISTS main.accounts`;
});

// ---------------------------------------------------------------- accounts

await step("create + load accounts", async () => {
  await sql`
    CREATE TABLE main.accounts (
      id         bigint PRIMARY KEY,
      name       text   NOT NULL,
      email      text,
      country    char(2) NOT NULL,
      created_at timestamptz NOT NULL
    )`;
  // VIOLATIONS: every 500th account collides with the next one (integer division
  // by 1000 maps two of them onto the same address), so ADD UNIQUE(email) has real
  // duplicates to report in pre-flight validation. Every 97th email is NULL.
  await sql`
    INSERT INTO main.accounts
    SELECT g,
           'account_' || g,
           CASE WHEN g % 500 = 0 THEN 'dupe_' || (g / 1000) || '@example.com'
                WHEN g % 97  = 0 THEN NULL
                ELSE 'user' || g || '@example.com' END,
           (ARRAY['US','GB','IN','DE'])[1 + (g % 4)],
           now() - ((g % 700000) * interval '1 second')
      FROM generate_series(1::bigint, ${ACCOUNTS}::bigint) g`;
});

// ---------------------------------------------------------------- txns

await step("create txns (unlogged)", async () => {
  await sql`
    CREATE UNLOGGED TABLE main.txns (
      id           bigint PRIMARY KEY,
      account_id   bigint NOT NULL,
      amount_cents bigint NOT NULL,
      currency     text   NOT NULL,
      status       text   NOT NULL,
      memo         text,
      created_at   timestamptz NOT NULL
    )`;
});

for (let lo = 1; lo <= ROWS; lo += CHUNK) {
  const hi = Math.min(lo + CHUNK - 1, ROWS);
  await step(`load rows ${lo.toLocaleString()}-${hi.toLocaleString()}`, async () => {
    // VIOLATIONS: ~2% of memos are NULL, so SET NOT NULL on memo has real
    // violating rows for pre-flight validation to count.
    await sql`
      INSERT INTO main.txns
      SELECT g,
             (g % ${Math.max(1, Math.floor(ACCOUNTS))}::bigint) + 1,
             (random() * 1000000)::bigint,
             (ARRAY['USD','EUR','INR','GBP'])[1 + (g % 4)],
             (ARRAY['pending','settled','failed','refunded'])[1 + (g % 4)],
             CASE WHEN g % 50 = 0 THEN NULL
                  ELSE md5(g::text) || md5((g * 7)::text) || md5((g * 13)::text) END,
             now() - ((g % 900000) * interval '1 second')
        FROM generate_series(${lo}::bigint, ${hi}::bigint) g`;
  });
}

await step("create index txns_account_idx", () => sql`CREATE INDEX txns_account_idx ON main.txns(account_id)`);
await step("create index txns_created_idx", () => sql`CREATE INDEX txns_created_idx ON main.txns(created_at)`);
await step("set logged (rewrites + WAL)", () => sql`ALTER TABLE main.txns SET LOGGED`);
await step("vacuum analyze", async () => {
  await sql`VACUUM ANALYZE main.txns`;
  await sql`VACUUM ANALYZE main.accounts`;
});

// ---------------------------------------------------------------- report

const [sizes] = await sql`
  SELECT pg_size_pretty(pg_total_relation_size('main.txns'))     AS txns,
         pg_size_pretty(pg_total_relation_size('main.accounts')) AS accounts,
         pg_total_relation_size('main.txns')                     AS txns_bytes`;
const [viol] = await sql`
  SELECT (SELECT count(*) FROM main.txns WHERE memo IS NULL)                        AS null_memos,
         (SELECT count(*) FROM (SELECT email FROM main.accounts WHERE email IS NOT NULL
                                 GROUP BY email HAVING count(*) > 1) d)             AS dupe_emails`;

console.log(`\n  txns     ${sizes.txns}`);
console.log(`  accounts ${sizes.accounts}`);
console.log(`\n  seeded violations (for pre-flight validation demos):`);
console.log(`    main.txns.memo IS NULL      ${Number(viol.null_memos).toLocaleString()} rows`);
console.log(`    main.accounts.email dupes   ${Number(viol.dupe_emails).toLocaleString()} keys`);
console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (Number(sizes.txns_bytes) < 5 * 1024 ** 3) {
  console.log(`\n  NOTE: txns is under 5GB. Re-run with --rows=${Math.ceil(ROWS * 1.1)} to clear the bar.`);
}

await sql.end();
