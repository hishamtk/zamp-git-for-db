# BUILD.md — Executable build spec

**Read `PLAN.md` first for the *why*. This file is the *what* and the *how*.**
It is written for an agent starting cold with no conversation history.

Build order below is dependency-ordered. Do not skip ahead — later tasks assume earlier
types exist. Each task has **acceptance criteria**; do not mark a task done until they pass.

---

## 0. Non-negotiable invariants

Violating any of these breaks the project's thesis. They are not preferences.

1. **Never run `ALTER TABLE` unguarded.** Every DDL statement goes through `guardedDDL()`
   (task 12), which sets `lock_timeout` and retries with backoff. No exceptions except
   `CREATE INDEX CONCURRENTLY`, which has its own path (task 16).
2. **Never copy the 5 GB table.** A branch is views only. If you find yourself writing
   `CREATE TABLE … AS SELECT` against `main.txns`, you have taken a wrong turn.
3. **Backfills must have a sync trigger** (task 15). Without it, rows written after the
   backfill sweeps past their PK silently keep NULLs. This is the one bug that would ship
   looking fine and corrupt data.
4. **Contract never runs automatically.** It is the only destructive step. User-triggered only.
5. **Diff the catalog, never text.** No `pg_dump` parsing anywhere.
6. **Column order is not semantic.** Reordering columns must produce an empty diff.

### Semantics — settle these before writing routes

**Working tree vs commit.** A branch's live view definitions *are* its working tree.
`POST /ddl` mutates them immediately (regenerating views, ~1 ms) and leaves the branch
**dirty**. `POST /commit` snapshots the current IR into `gitdb.commits` and advances
`branches.head_commit`. So:

- `GET /branches/:b/schema` → the **working tree** IR (what the views currently expose)
- diffing `main` vs a branch uses the branch's **working tree**, so uncommitted changes are visible in the diff
- **merge operates on committed state only** — refuse to merge a dirty branch with `409 { state: 'dirty' }`

This mirrors git closely enough to be unsurprising, and needs no staging area.

**Merge targets.** Merges go **branch → `main` only**. Branch-to-branch merges are out of
scope (they'd require the LCA walk that `PLAN.md` §3.4 explicitly cuts). Reject with a clear
message rather than silently misbehaving.

**Branch naming.** `^[a-z0-9][a-z0-9-]{0,38}$`. Schema name is `br_` + the name with `-`→`_`.
Reject anything else at the route; never interpolate an unvalidated identifier into SQL.

**Authoring model — SQL only.** Users write ordinary Postgres DDL in a text editor;
`libpg-query` parses it into `SchemaOp[]`. There is **no form-based editor**. `POST /ddl`
accepts `{sql}`; the `{ops}` variant exists only for internal/test use. Reject valid-but-
unsupported DDL explicitly against the whitelist — never silently ignore a statement. Accept
schema DDL only; reject DML (`INSERT`/`UPDATE`/`DELETE`) from this endpoint.

**Target database — bundled only.** The app manages the Postgres it ships with. No
connection-string input, no credential handling. Keep `introspect(schema)` and the view
generator parameterised by schema name so bring-your-own stays a later addition.

**Primary user — the platform engineer.** Someone shipping a schema change to production
without an incident. The app developer using a branch as a sandbox is secondary. Where they
conflict, the platform engineer wins. Concretely: the **merge preview is the centre of the
product**, not the SQL editor; every op shows a risk badge; live migration telemetry is a
first-class screen, not a spinner; contract is a distinctly styled destructive action.

### Measured facts — do not re-derive these

Measured on Postgres 17, 20 M rows / 4 GB table, 20-core NVMe machine:

| Operation | Result |
|---|---|
| `CREATE SCHEMA` + `CREATE VIEW` branch | 4 ms, 0 bytes |
| Point lookup through a branch view | 0.009 ms (index scan, predicate pushed down) |
| Aggregate through view vs direct | 956 ms vs 962 ms (~0% overhead) |
| `ADD COLUMN` nullable, no default | 2.4 ms |
| `ADD COLUMN NOT NULL DEFAULT 'x'` (constant) | 1.4 ms |
| `ADD COLUMN DEFAULT gen_random_uuid()` (volatile) | **38,182 ms** — full rewrite |
| `SET NOT NULL` naive | 2,670 ms, `AccessExclusiveLock` |
| `CREATE INDEX` blocking | 6,316 ms |
| `ALTER COLUMN TYPE` with a dependent view | **ERROR: cannot alter type of a column used by a view or rule** |
| drop-views → alter type → recreate (4 GB) | 23,986 ms holding `AccessExclusiveLock` |
| Naive DDL behind a reader: a 3 ms `SELECT` | blocked **3,098 ms** then timed out |
| Same DDL with `SET LOCAL lock_timeout='500ms'` | aborted cleanly in **605 ms** |
| Batched backfill throughput | **136 k rows/sec** (20 M rows in 147 s) |
| Table size after one full backfill | **4 GB → 8.5 GB** (MVCC dead tuples) |
| Seeding 20 M rows + 2 indexes | 80 s |

---

## 1. Stack and layout

Node 22 · TypeScript · Fastify · `postgres.js` · `libpg-query` · Zod · Vitest ·
Vite + React + Tailwind + shadcn/ui · Postgres 17 (Docker).

```
docker-compose.yml
package.json                 # npm workspaces: api, web
infra/
  seed.mjs                   # 25 M row txns + 50 MB accounts
  Caddyfile
api/
  src/
    index.ts                 # fastify bootstrap + ws
    db.ts                    # postgres.js clients (pool + a dedicated worker conn)
    ir/
      types.ts               # SchemaIR + Zod schemas   <- task 3
      introspect.ts          # pg_catalog -> IR          <- task 4
      canonical.ts           # canonical JSON + sha256   <- task 5
      parse.ts               # libpg-query DDL -> SchemaOp[]
    diff/
      diff.ts                # IR x IR -> SchemaOp[]     <- task 8
      classify.ts            # SAFE | LOCKING | REWRITE  <- task 9
      rename.ts              # rename detection          <- task 10
    vcs/
      branches.ts            # <- task 6
      commits.ts             # <- task 7
      merge.ts               # 3-way                     <- task 11
    engine/
      guarded.ts             # guardedDDL                <- task 12
      views.ts               # branch view SQL generation<- task 6
      deps.ts                # view dependency resolver  <- task 14
      plan.ts                # SchemaOp[] -> MigrationStep[] <- task 13
      runner.ts              # resumable executor        <- task 13
      backfill.ts            # batched + sync trigger    <- task 15
      indexes.ts             # CIC non-transactional path<- task 16
      contract.ts            # manual contract + revert  <- task 17
      validate.ts            # pre-flight                <- task 20
    routes/
    telemetry.ts             # ws event bus
  test/
web/
decisions.md
```

Two Postgres connections matter: a **pool** for API requests, and a **dedicated
long-lived connection** for the migration worker. Do not run a 3-minute backfill on a
pooled connection.

---

## 2. Tasks

### Task 1 — docker-compose + repo skeleton
`docker-compose.yml` with `db` (postgres:17, `shared_buffers=2GB`, `max_wal_size=8GB`,
`shm_size=1g`), `api`, `web`. npm workspaces. Health checks on all three.

**Accept:** `docker compose up` → all healthy; `GET /api/health` returns 200.

### Task 2 — seed script
`infra/seed.mjs`. Two tables in schema `main`:

```sql
CREATE TABLE main.txns (
  id bigint PRIMARY KEY, account_id bigint NOT NULL, amount_cents bigint NOT NULL,
  currency text NOT NULL, status text NOT NULL, memo text,
  created_at timestamptz NOT NULL);
CREATE INDEX txns_account_idx ON main.txns(account_id);
CREATE INDEX txns_created_idx ON main.txns(created_at);

CREATE TABLE main.accounts (
  id bigint PRIMARY KEY, name text NOT NULL, email text,
  country char(2) NOT NULL, created_at timestamptz NOT NULL);
```

`txns` = 25 M rows (~5 GB) via `generate_series` + `INSERT … SELECT`. Create it `UNLOGGED`,
load, build indexes, then `SET LOGGED`, then `VACUUM ANALYZE`. ~100 s.
`accounts` = 200 k rows (~50 MB) — this is the reviewer's fast path.

**Seed ~2% NULL `memo` and some duplicate `accounts.email`** deliberately. Pre-flight
validation (task 20) needs real violations to find, and the demo needs them.

**Accept:** `pg_total_relation_size('main.txns')` ≥ 5 GB; seeding completes < 3 min.

### Task 3 — Schema IR types
`api/src/ir/types.ts`.

```ts
export type SchemaIR = { version: 1; tables: Table[] };          // tables sorted by name

export type Table = {
  name: string;
  columns: Column[];        // sorted by NAME, not ordinal
  constraints: Constraint[];// sorted by name
  indexes: Index[];         // sorted by name
};

export type Column = {
  name: string;
  physicalName: string;     // usually === name; differs mid-migration. REQUIRED.
  type: string;             // canonical, e.g. 'pg_catalog.int4', 'pg_catalog.varchar(255)'
  nullable: boolean;
  default: string | null;   // canonical expression text
  ordinal: number;          // informational ONLY — excluded from the hash
};

export type Constraint = {
  name: string;
  kind: 'primary' | 'unique' | 'check' | 'foreign';
  columns: string[];
  expression?: string;      // for check
  references?: { table: string; columns: string[] };
  validated: boolean;
};

export type Index = {
  name: string; columns: string[]; unique: boolean; method: 'btree';
  predicate?: string;       // partial index
};
```

`physicalName` is load-bearing — see `PLAN.md` §3.3. Do not omit it.
Mirror every type with a Zod schema for request validation.

**Accept:** types compile; Zod schemas round-trip a hand-written fixture.

### Task 4 — Catalog introspector
`api/src/ir/introspect.ts`: `introspect(schema: string): Promise<SchemaIR>`.

Query `pg_catalog` (not `information_schema` — it's slower and lossier):
`pg_class` / `pg_attribute` / `pg_type` / `pg_constraint` / `pg_index` / `pg_attrdef`.

Canonicalize types via `format_type(atttypid, atttypmod)`, then normalize to the
`pg_catalog.*` form that `libpg-query` emits, so parsed DDL and introspected catalog agree.
Keep a ~20-entry alias map for bare internal names (`int4`, `timestamptz`, `bpchar`) that
the parser leaves unqualified.

Skip and log anything outside the whitelist (partitions, matviews, procedures, triggers).

**Accept:** `introspect('main')` on the seeded DB returns both tables with correct types,
the 2 indexes, and the PKs. `varchar(255)` and `character varying(255)` produce the
identical `type` string.

### Task 5 — Canonical JSON + hashing
`api/src/ir/canonical.ts`: `canonicalJSON(ir)` and `hashIR(ir): string` (sha256 hex).

Rules: object keys sorted; arrays sorted by `name`; **`ordinal` omitted**; no whitespace;
`null` and absent are distinct.

**Accept:** two IRs differing only in column order hash **identically**. Two differing in
one type do not. Hashing is stable across processes.

### Task 6 — Branch engine
`api/src/vcs/branches.ts` + `api/src/engine/views.ts`.

Create: `CREATE SCHEMA br_<slug>`, then for each table in the parent IR one view. Record
the branch in `gitdb.branches` with `base_commit` = parent HEAD.

View SQL is generated from the branch's target IR against the parent's *physical* columns:

| Op in branch | Select-list fragment |
|---|---|
| unchanged | `col` |
| add column | `NULL::<type> AS <name>` (or the default expression) |
| drop column | omitted |
| rename | `<physicalName> AS <name>` |
| retype | `<physicalName>::<type> AS <name>` |

New tables created in a branch are **real empty physical tables** in the branch schema.
Dropping a table in a branch drops the view.

**Constraints and indexes declared in a branch are recorded in the IR only — not created.**
Postgres cannot attach either to a view, and branches share physical storage with `main`,
so branch-local enforcement would be incoherent (two branches could demand contradictory
constraints on the same rows). This is correct declarative behaviour, not a limitation —
but the UI **must** show these as *"declared — validated against real data, enforced on
merge"* (task 20), never as if they were live.

**Accept:** `POST /api/branches` completes in < 100 ms against the 5 GB DB. The branch
returns 25 M rows. `SET search_path TO br_x, main` routes correctly. Branch schemas
occupy 0 bytes.

### Task 7 — `gitdb` metadata + commits
```sql
CREATE SCHEMA gitdb;
CREATE TABLE gitdb.branches (
  name text PRIMARY KEY, head_commit text, base_commit text,
  schema_name text NOT NULL, stale_reason text, created_at timestamptz DEFAULT now());
CREATE TABLE gitdb.commits (
  id text PRIMARY KEY,               -- sha256(canonicalJSON(ir))
  parent_id text, branch text, message text,
  ir jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE gitdb.merges (
  id bigserial PRIMARY KEY, source_commit text, target_commit text, base_commit text,
  plan jsonb, state text NOT NULL,   -- planned|running|merged|failed|reverted|contracted
  started_at timestamptz, contracted_at timestamptz);   -- NULL = still reversible
CREATE TABLE gitdb.merge_steps (
  merge_id bigint, seq int, kind text, sql text, state text,
  rows_done bigint DEFAULT 0, rows_total bigint, lock_attempts int DEFAULT 0, ms int,
  PRIMARY KEY (merge_id, seq));
CREATE TABLE gitdb.events (
  merge_id bigint, ts timestamptz DEFAULT now(), level text, payload jsonb);
```
Seed `main` branch + commit 0 from `introspect('main')`.

**Accept:** committing twice with no changes returns the same commit id (content-addressed
dedup).

### Task 8 — Diff engine ⭐ write tests first
`api/src/diff/diff.ts`: `diff(from: SchemaIR, to: SchemaIR): SchemaOp[]`.

```ts
export type SchemaOp =
  | { kind:'create_table'; table: Table }
  | { kind:'drop_table'; table: string }
  | { kind:'add_column'; table: string; column: Column }
  | { kind:'drop_column'; table: string; column: string }
  | { kind:'rename_column'; table: string; from: string; to: string }
  | { kind:'retype_column'; table: string; column: string; from: string; to: string; using?: string }
  | { kind:'set_nullable'; table: string; column: string; nullable: boolean }
  | { kind:'set_default'; table: string; column: string; default: string|null }
  | { kind:'add_constraint'; table: string; constraint: Constraint }
  | { kind:'drop_constraint'; table: string; constraint: string }
  | { kind:'add_index'; table: string; index: Index }
  | { kind:'drop_index'; table: string; index: string };
```

Deterministic output order. Pure function, no DB access — this is why it is the most
testable code in the project.

**Accept:** ~25 Vitest cases, including: identical IRs → `[]`; reordered columns → `[]`;
`varchar(255)` vs `character varying(255)` → `[]`; each op kind produced correctly;
dropping a table also drops its indexes/constraints without emitting separate ops.

### Task 9 — Risk classification
`api/src/diff/classify.ts`: `classify(op, ctx): 'SAFE'|'LOCKING'|'REWRITE'`.

| Op | Class | Notes |
|---|---|---|
| `add_column` nullable, no default | SAFE | 2.4 ms measured |
| `add_column` with **constant** default | SAFE | PG11+, 1.4 ms measured |
| `add_column` with **volatile** default (`now()`, `gen_random_uuid()`, `random()`) | **REWRITE** | 38 s measured |
| `drop_column` | SAFE | metadata only |
| `rename_column` | SAFE | |
| `retype_column` binary-coercible (`varchar(n)→text`, `varchar(n)→varchar(m>n)`) | SAFE | no rewrite |
| `retype_column` otherwise | **REWRITE** | |
| `set_nullable: true` (drop NOT NULL) | SAFE | |
| `set_nullable: false` (set NOT NULL) | LOCKING | use the `NOT VALID` path — task 13 |
| `add_index` | LOCKING | `CONCURRENTLY` — task 16 |
| `add_constraint` check / foreign | LOCKING | `NOT VALID` then `VALIDATE` |
| `add_constraint` unique | LOCKING | unique index CONCURRENTLY, then `ADD CONSTRAINT … USING INDEX` |
| `create_table` / `drop_table` / `drop_*` | SAFE | |

Maintain an explicit volatile-function list; default unknown functions to **volatile**
(fail safe).

**Accept:** unit test per row above.

### Task 10 — Rename detection
Candidate pair = a `drop_column` and an `add_column` in the same table with identical
type + nullability, plus name similarity (Levenshtein ≤ 3 or shared prefix ≥ 4).

Emit as a **suggestion**, never applied automatically. The API returns
`{ ops, renameSuggestions }`; the UI requires explicit confirmation. A rename mis-read as
drop+add destroys data.

**Accept:** `amount_cents → amount` is suggested; `memo` dropped + unrelated `notes` added
is **not**.

### Task 11 — Three-way merge
`api/src/vcs/merge.ts`: `merge(base, ours, theirs) → { ops } | { conflicts }`.

Use `branches.base_commit` — **no ancestor walk**. Key every object by path
(`table`, `table.column`, `table.constraint.<name>`, `table.index.<name>`) and compare:

| ours vs base | theirs vs base | Result |
|---|---|---|
| same | changed | take theirs |
| changed | same | keep ours |
| changed | changed, equal | converged, no-op |
| changed | changed, different | **CONFLICT** |

Conflicts carry `{ path, base, ours, theirs, reason }` and render as prose. Never auto-resolve.

**Accept:** both sides retyping the same column differently → conflict; disjoint branches
merge clean; main advancing on an untouched table does not conflict.

### Task 12 — `guardedDDL` ⭐ the heart of the project
`api/src/engine/guarded.ts`.

```ts
export async function guardedDDL(sql: Sql, ddl: string, emit: Emit, attempts = 15) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '500ms'`;
        await tx.unsafe(ddl);
        return { attempt: i };
      });
    } catch (e: any) {
      if (e.code !== '55P03') throw e;              // 55P03 = lock_not_available
      emit({ type: 'lock_retry', attempt: i, ddl });
      await sleep(Math.min(100 * 2 ** i, 5000) * (0.5 + Math.random()));
    }
  }
  throw new CouldNotAcquireLock(ddl);
}
```

**Accept — the project's single best test.** Open a competing transaction holding
`AccessShareLock` on `main.txns`; call `guardedDDL` with an `ALTER TABLE`; assert it emitted
≥ 1 `lock_retry` and did **not** block; assert a concurrent `SELECT` still returned in
< 50 ms. (Verified manually: naive = 3,098 ms block; guarded = 605 ms clean abort.)

### Task 13 — Plan compiler + resumable runner
`plan.ts` turns `SchemaOp[]` into ordered `MigrationStep[]` persisted to
`gitdb.merge_steps`. `runner.ts` executes steps in order, updating state per step, and
**resumes from the first non-complete step** on restart.

Expansion for a `REWRITE` retype (`amount_cents bigint → amount numeric(20,2)`):

```
1 EXPAND     ALTER TABLE main.txns ADD COLUMN amount numeric(20,2)     guarded, ~2 ms
2 SYNC       CREATE FUNCTION + BEFORE INSERT OR UPDATE TRIGGER         guarded  (task 15)
3 BACKFILL   batched UPDATE by PK range, VACUUM between groups         no DDL lock
4 VALIDATE   ADD CONSTRAINT … CHECK (amount IS NOT NULL) NOT VALID     guarded, instant
5 VALIDATE   VALIDATE CONSTRAINT                                       ShareUpdateExclusive
6 CUTOVER    one txn: drop trigger+function, ALTER COLUMN amount_cents
             DROP NOT NULL, regenerate all dependent views             guarded, ~10 ms
   ─────────── state = 'merged', contracted_at IS NULL, revert is free ───────────
7 CONTRACT   ALTER TABLE main.txns DROP COLUMN amount_cents            MANUAL ONLY
```

**`SET NOT NULL` does NOT need a helper column.** Nothing about the values changes. Use:
```sql
ALTER TABLE t ADD CONSTRAINT c CHECK (col IS NOT NULL) NOT VALID;  -- instant, metadata
ALTER TABLE t VALIDATE CONSTRAINT c;       -- ShareUpdateExclusive: blocks neither r nor w
ALTER TABLE t ALTER COLUMN col SET NOT NULL;  -- PG12+ uses the validated constraint, no scan
```
Naive `SET NOT NULL` measured 2,670 ms of `AccessExclusiveLock`. Column duplication is only
for ops where **values** change.

Step 6 must drop `NOT NULL` on the orphaned old column, or inserts through the new views
(which no longer supply it) will fail.

**Accept:** `bigint → numeric` on 25 M rows completes with no query blocked > 50 ms; killing
the API mid-backfill and restarting resumes at the right step.

### Task 14 — View dependency resolver
Landmine: `ALTER COLUMN TYPE` errors with `cannot alter type of a column used by a view or
rule`. Every branch is a view over `main`, so every open branch blocks it.

You **own** every view (they're all in `gitdb.branches`), so read your own registry rather
than `pg_depend`. Still cross-check `pg_depend`/`pg_rewrite` defensively and fail loudly on
an unknown dependent view.

In one transaction: drop dependent views in reverse topological order → run the DDL →
recreate them from each branch's IR. The whole transaction goes through `guardedDDL`.

If a branch's view references a column that no longer exists, set `branches.stale_reason`
instead of failing the merge: *"stale: main dropped `memo`, which this branch references."*

**Accept:** a retype merge succeeds with 3 open branches; all 3 branches still queryable
afterwards, or are marked stale with a readable reason.

### Task 15 — Backfill + sync trigger ⚠️ correctness-critical
`api/src/engine/backfill.ts`.

Batched by PK range with a **persisted cursor** in `merge_steps.rows_done` (not a
`WHERE new IS NULL` predicate — that breaks when the computed value is legitimately NULL).

```sql
UPDATE main.txns SET amount = amount_cents / 100.0
 WHERE id > $cursor AND id <= $cursor + $batch;
```

- `VACUUM main.txns` every N batches (N ≈ 20). **Measured: one full backfill grew the table 4 GB → 8.5 GB.** Report live bloat over the WebSocket.
- Adaptive batch size: > 1 s → halve; < 200 ms → grow 1.5× (cap 500 k).
- Emit `{ rowsDone, rowsTotal, rowsPerSec, etaSec, bloatBytes }` each batch.

**The sync trigger is not optional.** Without it, any row the application inserts or updates
*after* the sweep passes its PK keeps a NULL, and you cut over to a column with silent holes:

```sql
CREATE FUNCTION gitdb.sync_<mergeid>() RETURNS trigger AS $$
BEGIN NEW.amount := NEW.amount_cents / 100.0; RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER sync_<mergeid> BEFORE INSERT OR UPDATE ON main.txns
  FOR EACH ROW EXECUTE FUNCTION gitdb.sync_<mergeid>();
```

Installed at step 2, dropped at cutover. This does **not** contradict rejecting
`pt-online-schema-change`: that mirrors every write into a full shadow table; this assigns
one column on a row already being written.

**Accept — the backfill race test.** Start a backfill; while it runs, write rows *behind*
the sweep point; assert the new column is correct for those rows. Remove the trigger and
assert the test fails.

### Task 16 — Index path (non-transactional)
`CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block**, so it cannot use
`guardedDDL` as written. It needs its own path:

1. Run on the dedicated worker connection, outside any transaction, with a statement timeout but no `lock_timeout` wrapper.
2. Afterwards check `pg_index.indisvalid` for the new index.
3. If invalid, `DROP INDEX CONCURRENTLY` and retry (max 3), emitting telemetry each attempt.

Blocking `CREATE INDEX` measured 6,316 ms; concurrent takes `ShareUpdateExclusive` and
blocks no writes. For unique constraints: build a unique index concurrently, then
`ALTER TABLE … ADD CONSTRAINT … UNIQUE USING INDEX`.

**Accept:** index creation on 25 M rows never blocks a concurrent `INSERT`; a deliberately
failed CIC leaves no invalid index behind.

### Task 17 — Manual contract + revert
- Merge finishes at state `merged`, `contracted_at IS NULL`.
- `POST /api/merges/:id/revert` — only while `contracted_at IS NULL`. Regenerate views to the pre-merge IR, drop the added column. Lossless.
- `POST /api/merges/:id/contract` — `guardedDDL('ALTER TABLE … DROP COLUMN <old>')`, set `contracted_at`. UI labels it *"permanently drop `amount_cents`, reclaim ~1.2 GB"*.
- Refuse contract while a branch view still references the column; list the branches.

**Accept:** merge → revert restores the exact original IR hash. Contract then revert is
refused with a clear message.

### Task 18 — API routes
```
GET    /api/branches
POST   /api/branches            {name, from}
DELETE /api/branches/:name
GET    /api/branches/:name/schema        -> {ir, hash}
POST   /api/branches/:name/ddl           {sql} | {ops}
POST   /api/branches/:name/commit        {message}
GET    /api/branches/:name/log
GET    /api/diff?from=<ref>&to=<ref>     -> {ops, renameSuggestions}
POST   /api/merges                       {source, target}  -> plan (dry run, no writes)
POST   /api/merges/:id/apply
POST   /api/merges/:id/revert
POST   /api/merges/:id/contract
GET    /api/merges/:id
WS     /api/merges/:id/events
POST   /api/validate                     {branch}  -> violations   (task 20)
POST   /api/demo/reset
```

Serialize all merges with `pg_advisory_lock`. A second caller gets
`409 { state: 'merge_in_progress', mergeId }`, never a 500 — concurrent reviewers are
expected. `/api/demo/reset` returns `main` to commit 0 by running the engine forward to the
old IR.

### Task 19 — UI
Vite + React + Tailwind + shadcn. Import `SchemaIR` and `SchemaOp` **directly** from the api
workspace; no codegen, no duplicated types.

Screens: branch list (with size = 0 bytes and row count, to make the point); table browser
querying real data through the branch; DDL editor; split-pane diff colour-coded by risk
class; merge preview showing the compiled plan with per-step risk and ETA; live merge view
driven by the WebSocket (lock attempts, rows/s, %, bloat).

**Design these five states explicitly** — the rubric names them: first-run, empty, in
progress, conflict, failure. Declared-but-not-enforced constraints need a visible badge
(*"declared — enforced on merge"*), or a reviewer will read it as a bug.

### Task 20 — Pre-flight validation (the differentiator)
`api/src/engine/validate.ts`. For each pending op, query the real data:

| Op | Probe | Message |
|---|---|---|
| `set_nullable:false` | `SELECT count(*) … WHERE col IS NULL` | "blocked: 1,284,993 rows violate this" |
| `retype` | `WHERE col !~ <castable pattern>` limit 10 | show offending rows |
| `add_constraint` unique | `GROUP BY col HAVING count(*)>1` limit 10 | show duplicate keys |
| `add_constraint` check | `WHERE NOT (<expr>)` | violation count |
| any REWRITE | rows × measured 136 k/s | "backfill ≈ 3 m 04 s, lock window ≈ 12 ms" |

This is the answer to *"why branch a real database instead of a schema dump?"* and the
reason declared-only constraints are better than fake enforcement.

### Task 21 — Tests
**Unit (no DB):** the ~25 diff cases (task 8), classification (task 9), rename detection
(task 10), canonical hashing (task 5), three-way merge (task 11).

**Integration (Testcontainers, small table):** branch creation idempotent; branch view
survives a parent DDL change; expand→backfill→cutover preserves every row; **merge killed
mid-backfill resumes**; **merge reverted before contract restores the exact IR hash**.

**The two that prove the thesis:** the lock-contention test (task 12) and the backfill race
test (task 15). If you write nothing else, write these.

### Task 22 — Deploy
Host on the workstation; expose via a **named** tunnel (Tailscale Funnel, or Cloudflare
Tunnel with a domain). Quick tunnels rotate their hostname on restart and are unacceptable.

```bash
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```
systemd units with `Restart=always`, `WantedBy=multi-user.target`, for both compose and the
tunnel. **Reboot to verify.** Do this early — it is requirement #1 in the brief.

### Task 23 — The proof
`pgbench -c 20 -T 300` against `main` during a merge; capture p99. Record the unguarded
control run too. Two charts — guarded (flat) vs naive (cliff) — in the README.

### Task 24 — `decisions.md` + README + demo video
Follow `PLAN.md` §7 (14 entries, four fields each: decision / alternatives / reasoning /
what was cut). Every entry ends with a measured number from §0 above. README: 60-second
quickstart, deployed URL, video at the top, honest availability note.

---

## 3. Known traps

0. **`CREATE OR REPLACE VIEW` cannot rename or drop columns** — `42P16: cannot change name of view column`. Since renaming and dropping is most of what a branch edit does, every view write must `DROP VIEW IF EXISTS` then plain `CREATE VIEW`. *(Hit during implementation; `createViewSQL()` emits the plain form deliberately.)*
0b. **Bound parameters make `generate_series` ambiguous** — `42725: could not choose a best candidate function`, because the driver sends untyped parameters. Cast explicitly: `generate_series(${lo}::bigint, ${hi}::bigint)`. Applies to any overloaded function you parameterise.
1. **`ALTER COLUMN TYPE` fails while any view references the column.** Task 14 exists for this.
2. **`CREATE INDEX CONCURRENTLY` can't be transactional** and leaves invalid indexes on failure. Task 16.
3. **Backfill doubles table size** (4 GB → 8.5 GB measured). `VACUUM` between batch groups; surface bloat.
4. **Volatile defaults trigger a full rewrite** (38 s measured). Classify as REWRITE and expand.
5. **Casts in a view make that column non-updatable.** A retyped branch column is read-only until merge. Say so in the UI.
6. **Orphaned column needs `DROP NOT NULL` at cutover**, or inserts through the new view fail.
7. **`postgres.js` `.unsafe()` is required for DDL** — parameters aren't allowed in DDL. Never interpolate user input: validate every identifier against the IR and quote with `format('%I')` semantics.
8. **Don't run the backfill on a pooled connection.** Use the dedicated worker connection.

---

## 4. Definition of done

- [ ] `docker compose up` on a clean clone → working app with a 5 GB DB
- [ ] Public HTTPS URL, survives a reboot
- [ ] Branch a 5 GB DB in < 100 ms, query 25 M rows through it
- [ ] All eight operations from the brief (add/drop/rename/retype columns; constraints; indexes; create/drop tables)
- [ ] Semantic diff, risk-classified, rendered side-by-side
- [ ] Three-way merge with readable conflicts
- [ ] Online merge: expand → sync → backfill → cutover, nothing blocked > 50 ms
- [ ] Manual contract; revert lossless before it
- [ ] Live telemetry during a real 5 GB merge
- [ ] Lock-contention test and backfill-race test both pass
- [ ] pgbench p99 chart, guarded vs naive
- [ ] `decisions.md`, README, demo video
