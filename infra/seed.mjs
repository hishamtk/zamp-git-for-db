#!/usr/bin/env node
/**
 * Seed the demo database.
 *
 *   main.txns       ~25M rows / ~5GB  — credibility table (full rewrite / backfill)
 *   main.accounts   ~200k rows        — fast branch → diff → merge path
 *   main.merchants  ~20k rows         — extra catalog for multi-table diffs
 *   main.cards      ~400k rows        — extra catalog + unique-fingerprint violations
 *   main.disputes   ~500k rows        — extra catalog + nullable-reason violations
 *
 * Measured: 20M txns + 2 indexes in ~80s, so 25M lands near 100s.
 * Bulk tables are created UNLOGGED, loaded, indexed, then SET LOGGED.
 *
 * Deliberate constraint violations are documented under VIOLATIONS below.
 *
 *   node infra/seed.mjs
 *   node infra/seed.mjs --rows=25000000 --accounts=200000 --merchants=20000 --cards=400000 --disputes=500000
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
const MERCHANTS = Number(String(args.merchants ?? "20000").replaceAll("_", ""));
const CARDS = Number(String(args.cards ?? "400000").replaceAll("_", ""));
const DISPUTES = Number(String(args.disputes ?? "500000").replaceAll("_", ""));
const URL = args.url ?? process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";
const TXN_CHUNK = 5_000_000;
const DISPUTE_CHUNK = 250_000;

const sql = postgres(URL, { max: 1, idle_timeout: 0, max_lifetime: 0, onnotice: () => {} });

const t0 = Date.now();
const step = async (label, fn) => {
  const s = Date.now();
  process.stdout.write(`  ${label} ... `);
  const r = await fn();
  console.log(`${((Date.now() - s) / 1000).toFixed(1)}s`);
  return r;
};

const accounts = Math.max(1, ACCOUNTS);
const merchants = Math.max(1, MERCHANTS);
const FORCE = args.force === "true" || args.force === "" || process.env.FORCE_SEED === "1";
const MISSING_ONLY = args["missing-only"] === "true" || args["missing-only"] === "";

console.log(`\nSeeding ${URL.replace(/:[^:@]*@/, ":***@")}`);
console.log(
  `  txns=${ROWS.toLocaleString()} accounts=${accounts.toLocaleString()} ` +
    `merchants=${merchants.toLocaleString()} cards=${CARDS.toLocaleString()} ` +
    `disputes=${DISPUTES.toLocaleString()}\n`,
);

const tablePresent = async (name) => {
  const [row] = await sql`SELECT to_regclass(${`main.${name}`}) IS NOT NULL AS present`;
  return Boolean(row?.present);
};

if (MISSING_ONLY) {
  if (!(await tablePresent("merchants"))) {
    await step("create + load merchants", async () => {
      await sql`
        CREATE TABLE main.merchants (
          id         bigint PRIMARY KEY,
          name       text   NOT NULL,
          category   text   NOT NULL,
          country    char(2) NOT NULL,
          website    text,
          created_at timestamptz NOT NULL
        )`;
      await sql`
        INSERT INTO main.merchants
        SELECT g,
               'merchant_' || g,
               (ARRAY['retail','saas','travel','food','gaming'])[1 + (g % 5)],
               (ARRAY['US','GB','IN','DE','SG'])[1 + (g % 5)],
               CASE WHEN g % 100 = 0 THEN NULL
                    ELSE 'https://m' || g || '.example.com' END,
               now() - ((g % 400000) * interval '1 second')
          FROM generate_series(1::bigint, ${merchants}::bigint) g`;
      await sql`CREATE INDEX merchants_category_idx ON main.merchants(category)`;
    });
  }
  if (!(await tablePresent("cards"))) {
    await step("create + load cards", async () => {
      await sql`
        CREATE TABLE main.cards (
          id           bigint PRIMARY KEY,
          account_id   bigint NOT NULL,
          last4        char(4) NOT NULL,
          brand        text   NOT NULL,
          exp_month    smallint NOT NULL,
          exp_year     smallint NOT NULL,
          status       text   NOT NULL,
          fingerprint  text,
          created_at   timestamptz NOT NULL
        )`;
      await sql`
        INSERT INTO main.cards
        SELECT g,
               (g % ${accounts}::bigint) + 1,
               lpad(((g * 17) % 10000)::text, 4, '0'),
               (ARRAY['visa','mastercard','amex','discover'])[1 + (g % 4)],
               1 + (g % 12),
               2027 + (g % 6),
               (ARRAY['active','expired','stolen','blocked'])[1 + (g % 4)],
               CASE WHEN g % 200 = 0 THEN 'fp_dupe_' || (g / 400)
                    ELSE 'fp_' || g END,
               now() - ((g % 500000) * interval '1 second')
          FROM generate_series(1::bigint, ${CARDS}::bigint) g`;
      await sql`CREATE INDEX cards_account_idx ON main.cards(account_id)`;
      await sql`CREATE INDEX cards_fingerprint_idx ON main.cards(fingerprint)`;
    });
  }
  if (!(await tablePresent("disputes"))) {
    await step("create + load disputes", async () => {
      await sql`
        CREATE UNLOGGED TABLE main.disputes (
          id           bigint PRIMARY KEY,
          txn_id       bigint NOT NULL,
          account_id   bigint NOT NULL,
          merchant_id  bigint NOT NULL,
          reason       text,
          status       text   NOT NULL,
          amount_cents bigint NOT NULL,
          opened_at    timestamptz NOT NULL,
          resolved_at  timestamptz
        )`;
      for (let lo = 1; lo <= DISPUTES; lo += DISPUTE_CHUNK) {
        const hi = Math.min(lo + DISPUTE_CHUNK - 1, DISPUTES);
        await sql`
          INSERT INTO main.disputes
          SELECT g,
                 ((g - 1) % ${Math.max(1, ROWS)}::bigint) + 1,
                 (g % ${accounts}::bigint) + 1,
                 (g % ${merchants}::bigint) + 1,
                 CASE WHEN g % 33 = 0 THEN NULL
                      ELSE (ARRAY['fraud','duplicate','product_not_received','credit_not_processed'])[1 + (g % 4)] END,
                 (ARRAY['open','won','lost','cancelled'])[1 + (g % 4)],
                 100 + (g % 250000),
                 now() - ((g % 800000) * interval '1 second'),
                 CASE WHEN g % 4 = 0 THEN NULL
                      ELSE now() - ((g % 400000) * interval '1 second') END
            FROM generate_series(${lo}::bigint, ${hi}::bigint) g`;
      }
      await sql`CREATE INDEX disputes_txn_idx ON main.disputes(txn_id)`;
      await sql`CREATE INDEX disputes_account_idx ON main.disputes(account_id)`;
      await sql`ALTER TABLE main.disputes SET LOGGED`;
    });
  }
  await step("vacuum restored tables", async () => {
    if (await tablePresent("merchants")) await sql`VACUUM ANALYZE main.merchants`;
    if (await tablePresent("cards")) await sql`VACUUM ANALYZE main.cards`;
    if (await tablePresent("disputes")) await sql`VACUUM ANALYZE main.disputes`;
  });
  const sizes = await sql`
    SELECT c.relname AS name,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty,
           c.reltuples::bigint AS est_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'main' AND c.relname = ANY(${["merchants", "accounts", "cards", "txns", "disputes"]})
     ORDER BY pg_total_relation_size(c.oid) DESC`;
  console.log("");
  for (const row of sizes) {
    console.log(`  ${String(row.name).padEnd(12)} ${row.pretty.padStart(10)}  ~${Number(row.est_rows).toLocaleString()} rows`);
  }
  console.log(`\n  missing-only restore ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sql.end();
  process.exit(0);
}

if (!FORCE) {
  const [existing] = await sql`SELECT to_regclass('main.txns') IS NOT NULL AS present`;
  if (existing?.present) {
    const [n] = await sql`SELECT count(*)::bigint AS n FROM main.txns`;
    if (Number(n.n) > 0) {
      const [sizes] = await sql`
        SELECT pg_size_pretty(pg_total_relation_size('main.txns')) AS txns`;
      console.log(`main.txns already has ${Number(n.n).toLocaleString()} rows (${sizes.txns}).`);
      console.log("Skipping seed. Pass --force (or FORCE_SEED=1) to rebuild the tables.\n");
      await sql.end();
      process.exit(0);
    }
  }
}

await step("create schema main", async () => {
  await sql`CREATE SCHEMA IF NOT EXISTS main`;
  await sql.unsafe(`
    DROP TABLE IF EXISTS
      main.disputes,
      main.cards,
      main.txns,
      main.accounts,
      main.merchants
    CASCADE`);
});

await step("create + load merchants", async () => {
  await sql`
    CREATE TABLE main.merchants (
      id         bigint PRIMARY KEY,
      name       text   NOT NULL,
      category   text   NOT NULL,
      country    char(2) NOT NULL,
      website    text,
      created_at timestamptz NOT NULL
    )`;
  // VIOLATIONS: ~1% of websites are NULL, so SET NOT NULL on website has real rows.
  await sql`
    INSERT INTO main.merchants
    SELECT g,
           'merchant_' || g,
           (ARRAY['retail','saas','travel','food','gaming'])[1 + (g % 5)],
           (ARRAY['US','GB','IN','DE','SG'])[1 + (g % 5)],
           CASE WHEN g % 100 = 0 THEN NULL
                ELSE 'https://m' || g || '.example.com' END,
           now() - ((g % 400000) * interval '1 second')
      FROM generate_series(1::bigint, ${merchants}::bigint) g`;
});

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
  // duplicates. Every 97th email is NULL.
  await sql`
    INSERT INTO main.accounts
    SELECT g,
           'account_' || g,
           CASE WHEN g % 500 = 0 THEN 'dupe_' || (g / 1000) || '@example.com'
                WHEN g % 97  = 0 THEN NULL
                ELSE 'user' || g || '@example.com' END,
           (ARRAY['US','GB','IN','DE'])[1 + (g % 4)],
           now() - ((g % 700000) * interval '1 second')
      FROM generate_series(1::bigint, ${accounts}::bigint) g`;
});

await step("create + load cards", async () => {
  await sql`
    CREATE TABLE main.cards (
      id           bigint PRIMARY KEY,
      account_id   bigint NOT NULL,
      last4        char(4) NOT NULL,
      brand        text   NOT NULL,
      exp_month    smallint NOT NULL,
      exp_year     smallint NOT NULL,
      status       text   NOT NULL,
      fingerprint  text,
      created_at   timestamptz NOT NULL
    )`;
  // VIOLATIONS: colliding fingerprints so ADD UNIQUE(fingerprint) finds duplicates.
  await sql`
    INSERT INTO main.cards
    SELECT g,
           (g % ${accounts}::bigint) + 1,
           lpad(((g * 17) % 10000)::text, 4, '0'),
           (ARRAY['visa','mastercard','amex','discover'])[1 + (g % 4)],
           1 + (g % 12),
           2027 + (g % 6),
           (ARRAY['active','expired','stolen','blocked'])[1 + (g % 4)],
           CASE WHEN g % 200 = 0 THEN 'fp_dupe_' || (g / 400)
                ELSE 'fp_' || g END,
           now() - ((g % 500000) * interval '1 second')
      FROM generate_series(1::bigint, ${CARDS}::bigint) g`;
});

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

for (let lo = 1; lo <= ROWS; lo += TXN_CHUNK) {
  const hi = Math.min(lo + TXN_CHUNK - 1, ROWS);
  await step(`load txns ${lo.toLocaleString()}-${hi.toLocaleString()}`, async () => {
    // VIOLATIONS: ~2% of memos are NULL, so SET NOT NULL on memo has real
    // violating rows. Memo text is wide so 25M rows land near 5GB with indexes.
    await sql`
      INSERT INTO main.txns
      SELECT g,
             (g % ${accounts}::bigint) + 1,
             (random() * 1000000)::bigint,
             (ARRAY['USD','EUR','INR','GBP'])[1 + (g % 4)],
             (ARRAY['pending','settled','failed','refunded'])[1 + (g % 4)],
             CASE WHEN g % 50 = 0 THEN NULL
                  ELSE md5(g::text) || md5((g * 7)::text) || md5((g * 13)::text) || md5((g * 19)::text) END,
             now() - ((g % 900000) * interval '1 second')
        FROM generate_series(${lo}::bigint, ${hi}::bigint) g`;
  });
}

await step("create disputes (unlogged)", async () => {
  await sql`
    CREATE UNLOGGED TABLE main.disputes (
      id           bigint PRIMARY KEY,
      txn_id       bigint NOT NULL,
      account_id   bigint NOT NULL,
      merchant_id  bigint NOT NULL,
      reason       text,
      status       text   NOT NULL,
      amount_cents bigint NOT NULL,
      opened_at    timestamptz NOT NULL,
      resolved_at  timestamptz
    )`;
});

for (let lo = 1; lo <= DISPUTES; lo += DISPUTE_CHUNK) {
  const hi = Math.min(lo + DISPUTE_CHUNK - 1, DISPUTES);
  await step(`load disputes ${lo.toLocaleString()}-${hi.toLocaleString()}`, async () => {
    // VIOLATIONS: ~3% of reasons are NULL for SET NOT NULL demos.
    // txn_id wraps into the seeded txn range so IDs stay plausible without an FK scan.
    await sql`
      INSERT INTO main.disputes
      SELECT g,
             ((g - 1) % ${Math.max(1, ROWS)}::bigint) + 1,
             (g % ${accounts}::bigint) + 1,
             (g % ${merchants}::bigint) + 1,
             CASE WHEN g % 33 = 0 THEN NULL
                  ELSE (ARRAY['fraud','duplicate','product_not_received','credit_not_processed'])[1 + (g % 4)] END,
             (ARRAY['open','won','lost','cancelled'])[1 + (g % 4)],
             100 + (g % 250000),
             now() - ((g % 800000) * interval '1 second'),
             CASE WHEN g % 4 = 0 THEN NULL
                  ELSE now() - ((g % 400000) * interval '1 second') END
        FROM generate_series(${lo}::bigint, ${hi}::bigint) g`;
  });
}

await step("index merchants_category_idx", () =>
  sql`CREATE INDEX merchants_category_idx ON main.merchants(category)`);
await step("index cards_account_idx", () =>
  sql`CREATE INDEX cards_account_idx ON main.cards(account_id)`);
await step("index cards_fingerprint_idx", () =>
  sql`CREATE INDEX cards_fingerprint_idx ON main.cards(fingerprint)`);
await step("index txns_account_idx", () =>
  sql`CREATE INDEX txns_account_idx ON main.txns(account_id)`);
await step("index txns_created_idx", () =>
  sql`CREATE INDEX txns_created_idx ON main.txns(created_at)`);
await step("index disputes_txn_idx", () =>
  sql`CREATE INDEX disputes_txn_idx ON main.disputes(txn_id)`);
await step("index disputes_account_idx", () =>
  sql`CREATE INDEX disputes_account_idx ON main.disputes(account_id)`);

await step("set logged txns", () => sql`ALTER TABLE main.txns SET LOGGED`);
await step("set logged disputes", () => sql`ALTER TABLE main.disputes SET LOGGED`);
await step("vacuum analyze", async () => {
  await sql`VACUUM ANALYZE main.merchants`;
  await sql`VACUUM ANALYZE main.accounts`;
  await sql`VACUUM ANALYZE main.cards`;
  await sql`VACUUM ANALYZE main.txns`;
  await sql`VACUUM ANALYZE main.disputes`;
});

const tables = ["merchants", "accounts", "cards", "txns", "disputes"];
const sizes = await sql`
  SELECT c.relname AS name,
         pg_total_relation_size(c.oid) AS bytes,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty,
         c.reltuples::bigint AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'main' AND c.relname = ANY(${tables})
   ORDER BY pg_total_relation_size(c.oid) DESC`;

const [viol] = await sql`
  SELECT
    (SELECT count(*) FROM main.txns WHERE memo IS NULL) AS null_memos,
    (SELECT count(*) FROM (
       SELECT email FROM main.accounts WHERE email IS NOT NULL
        GROUP BY email HAVING count(*) > 1) d) AS dupe_emails,
    (SELECT count(*) FROM main.merchants WHERE website IS NULL) AS null_websites,
    (SELECT count(*) FROM (
       SELECT fingerprint FROM main.cards
        GROUP BY fingerprint HAVING count(*) > 1) d) AS dupe_fingerprints,
    (SELECT count(*) FROM main.disputes WHERE reason IS NULL) AS null_reasons`;

const totalBytes = sizes.reduce((n, r) => n + Number(r.bytes), 0);
const prettyTotal = await sql`SELECT pg_size_pretty(${totalBytes}::bigint) AS total`;

console.log("");
for (const row of sizes) {
  console.log(`  ${String(row.name).padEnd(12)} ${row.pretty.padStart(10)}  ~${Number(row.est_rows).toLocaleString()} rows`);
}
console.log(`  ${"total".padEnd(12)} ${prettyTotal[0].total.padStart(10)}`);
console.log(`\n  seeded violations (for pre-flight validation demos):`);
console.log(`    main.txns.memo IS NULL         ${Number(viol.null_memos).toLocaleString()} rows`);
console.log(`    main.accounts.email dupes      ${Number(viol.dupe_emails).toLocaleString()} keys`);
console.log(`    main.merchants.website IS NULL ${Number(viol.null_websites).toLocaleString()} rows`);
console.log(`    main.cards.fingerprint dupes   ${Number(viol.dupe_fingerprints).toLocaleString()} keys`);
console.log(`    main.disputes.reason IS NULL   ${Number(viol.null_reasons).toLocaleString()} rows`);
console.log(`\n  total ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (totalBytes < 5 * 1024 ** 3) {
  const next = Math.ceil(ROWS * ((5 * 1024 ** 3) / Math.max(totalBytes, 1)));
  console.log(`\n  NOTE: main schema is under 5GB. Re-run with --rows=${next} to clear the bar.`);
}

await sql.end();
