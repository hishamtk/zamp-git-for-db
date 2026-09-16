#!/usr/bin/env node
/**
 * Task 23 — guarded vs naive lock behaviour under concurrent readers.
 *
 * Reproduces the measured disaster: a queued unguarded ALTER TABLE blocks
 * arriving SELECTs (finding F), while the same ALTER with lock_timeout
 * aborts and leaves readers unblocked (finding G).
 *
 * Uses a dedicated proof table so the 5 GB `main.txns` demo is not rewritten.
 *
 *   node infra/proof.mjs
 *   PROOF_SECONDS=16 node infra/proof.mjs
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const SECONDS = Number(process.env.PROOF_SECONDS ?? 16);
const ROWS = Number(process.env.PROOF_ROWS ?? 20_000);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://gitdb:gitdb@localhost:55432/gitdb";
const CLIENTS = 20;
const READER_HOLD_MS = 6000;

const admin = postgres(DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, idle_timeout: 0 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(samples, p) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function summarise(samples) {
  let max = 0;
  for (const value of samples) if (value > max) max = value;
  return {
    n: samples.length,
    p50: Number(percentile(samples, 50).toFixed(3)),
    p95: Number(percentile(samples, 95).toFixed(3)),
    p99: Number(percentile(samples, 99).toFixed(3)),
    max: Number(max.toFixed(3)),
  };
}

function sparkline(samples, width = 56) {
  const buckets = Array.from({ length: width }, () => []);
  for (const [i, value] of samples.entries()) {
    buckets[Math.min(width - 1, Math.floor((i / samples.length) * width))].push(value);
  }
  const p99s = buckets.map((bucket) => (bucket.length ? percentile(bucket, 99) : 0));
  const peak = Math.max(1, ...p99s);
  const glyphs = "▁▂▃▄▅▆▇█";
  return p99s.map((value) => glyphs[Math.min(glyphs.length - 1, Math.floor((value / peak) * (glyphs.length - 1)))]).join("");
}

async function resetTable() {
  await admin`DROP TABLE IF EXISTS main.gitdb_proof CASCADE`;
  await admin`
    CREATE TABLE main.gitdb_proof (
      id bigint PRIMARY KEY,
      payload text NOT NULL
    )`;
  await admin`
    INSERT INTO main.gitdb_proof (id, payload)
    SELECT g, md5(g::text)
      FROM generate_series(1::bigint, ${ROWS}::bigint) g`;
}

async function hammer(seconds) {
  const samples = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: CLIENTS }, async () => {
    const client = postgres(DATABASE_URL, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      idle_timeout: 0,
      connect_timeout: 10,
    });
    try {
      while (Date.now() < end) {
        const id = 1 + Math.floor(Math.random() * ROWS);
        const t0 = performance.now();
        try {
          await client.unsafe("SET statement_timeout = '8s'");
          await client`SELECT id FROM main.gitdb_proof WHERE id = ${id}`;
        } catch {
          // Timeouts still count: that is the stall.
        }
        samples.push(performance.now() - t0);
        await sleep(8);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  }));
  return samples;
}

async function holdAccessShare(ms) {
  const holder = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, idle_timeout: 0 });
  try {
    await holder.begin(async (tx) => {
      await tx`SELECT id FROM main.gitdb_proof WHERE id = 1`;
      await tx.unsafe(`SELECT pg_sleep(${ms / 1000})`);
    });
  } finally {
    await holder.end({ timeout: 5 });
  }
}

async function naiveAlter() {
  const t0 = performance.now();
  await admin.unsafe("ALTER TABLE main.gitdb_proof ALTER COLUMN payload TYPE varchar(64)");
  return performance.now() - t0;
}

async function guardedAlter() {
  const t0 = performance.now();
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await admin.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '500ms'`;
        await tx`ALTER TABLE main.gitdb_proof ALTER COLUMN payload TYPE varchar(64)`;
      });
      return { ms: performance.now() - t0, attempts: attempt + 1, acquired: true };
    } catch (error) {
      if (error.code !== "55P03") throw error;
      await sleep(Math.min(100 * 2 ** attempt, 1500));
    }
  }
  return { ms: performance.now() - t0, attempts: 15, acquired: false };
}

function downsample(samples, n = 120) {
  const out = [];
  const size = Math.max(1, Math.floor(samples.length / n));
  for (let i = 0; i < samples.length; i += size) {
    out.push(percentile(samples.slice(i, i + size), 99));
  }
  return out;
}

function svgChart(naive, guarded) {
  const width = 720;
  const height = 220;
  const pad = 36;
  const series = (samples) => {
    const step = (width - pad * 2) / Math.max(samples.length - 1, 1);
    const peak = Math.max(50, ...samples, ...downsample(guarded, 120));
    return samples.map((value, i) => {
      const x = pad + i * step;
      const y = height - pad - (Math.min(value, peak) / peak) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#0d1014"/>
  <text x="${pad}" y="22" fill="#9aa3ad" font-family="ui-monospace,monospace" font-size="12">p99 SELECT latency (ms) — naive ALTER vs lock_timeout-guarded</text>
  <polyline fill="none" stroke="#f43f5e" stroke-width="1.6" points="${series(downsample(naive))}"/>
  <polyline fill="none" stroke="#73e2a7" stroke-width="1.6" points="${series(downsample(guarded))}"/>
  <text x="${width - 200}" y="22" fill="#f43f5e" font-family="ui-monospace,monospace" font-size="11">naive</text>
  <text x="${width - 140}" y="22" fill="#73e2a7" font-family="ui-monospace,monospace" font-size="11">guarded</text>
</svg>
`;
}

const started = Date.now();
console.log(`\nProof: ${CLIENTS} readers, ${SECONDS}s/side, competing AccessShareLock for ${READER_HOLD_MS}ms\n`);

await resetTable();
console.log("  naive ALTER behind a reader ...");
const naiveHammer = hammer(SECONDS);
await sleep(1500);
const naiveHold = holdAccessShare(READER_HOLD_MS);
await sleep(400);
const naiveAlterMs = await naiveAlter();
const naiveSamples = await naiveHammer;
await naiveHold;
const naive = summarise(naiveSamples);
console.log(`    alter ${naiveAlterMs.toFixed(0)}ms   p50=${naive.p50}  p99=${naive.p99}  max=${naive.max}`);
console.log(`    ${sparkline(naiveSamples)}`);

await resetTable();
console.log("  guarded ALTER behind a reader ...");
const guardedHammer = hammer(SECONDS);
await sleep(1500);
const guardedHold = holdAccessShare(READER_HOLD_MS);
await sleep(400);
const guardedResult = await guardedAlter();
const guardedSamples = await guardedHammer;
await guardedHold;
const guarded = summarise(guardedSamples);
console.log(`    ${guardedResult.acquired ? "acquired" : "deferred"} after ${guardedResult.attempts} attempt(s) in ${guardedResult.ms.toFixed(0)}ms`);
console.log(`    p50=${guarded.p50}  p99=${guarded.p99}  max=${guarded.max}`);
console.log(`    ${sparkline(guardedSamples)}`);

await admin`DROP TABLE IF EXISTS main.gitdb_proof CASCADE`;
await admin.end({ timeout: 5 });

const results = {
  measuredAt: new Date().toISOString(),
  rows: ROWS,
  clients: CLIENTS,
  seconds: SECONDS,
  readerHoldMs: READER_HOLD_MS,
  naiveAlterMs: Math.round(naiveAlterMs),
  guarded: { ...guardedResult, ms: Math.round(guardedResult.ms) },
  naiveLatency: naive,
  guardedLatency: guarded,
};
const dir = dirname(fileURLToPath(import.meta.url));
await writeFile(join(dir, "proof-results.json"), JSON.stringify(results, null, 2));
await writeFile(join(dir, "proof-chart.svg"), svgChart(naiveSamples, guardedSamples));
await writeFile(join(dir, "proof-results.md"), `# Lock proof

${CLIENTS} concurrent point lookups, plus a transaction holding \`AccessShareLock\`
for ${READER_HOLD_MS} ms. Same \`ALTER TABLE … TYPE\` on both sides.

| Path | ALTER outcome | p50 | p99 | max |
|---|---|---:|---:|---:|
| Naive (no lock_timeout) | queued ${results.naiveAlterMs} ms | ${naive.p50} ms | ${naive.p99} ms | ${naive.max} ms |
| Guarded (\`lock_timeout=500ms\`) | ${guardedResult.acquired ? "acquired after retry" : "aborted cleanly"} · ${guardedResult.attempts} attempt(s) | ${guarded.p50} ms | ${guarded.p99} ms | ${guarded.max} ms |

Naive (cliff while the ALTER is queued):
\`${sparkline(naiveSamples)}\`

Guarded (readers keep moving):
\`${sparkline(guardedSamples)}\`

Postgres grants locks FIFO. An unguarded \`ALTER TABLE\` waiting behind one
reader blocks every SELECT that arrives after it. \`SET LOCAL lock_timeout\`
makes the DDL fail instead of taking the application down.
`);

console.log(`\n  wrote infra/proof-results.md  (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
