# HANDOFF — pick up here

**Read order:** this file → `BUILD.md` (the spec) → `PLAN.md` (the why) → `decisions.md`.

Last committed work was Tasks 1–7. **Working tree is dirty** — Tasks 8–24 are
implemented and **not committed**. Postgres is running via `docker compose up -d db`.
A local API (`tsx src/index.ts` on :3001) and Vite (:5173) are also running.
Compose api/web were verified on **18080/18081** because those host ports were taken.

---

## Where things stand

`BUILD.md` has 24 tasks. **Tasks 1–23 are done** except a public named-tunnel URL
and the demo video (Task 24 leftovers).

| Task | What | State |
|---|---|---|
| 1 | docker-compose, npm workspaces, tsconfig | ✅ `db`/`api`/`web`/`seed` compose; `api/Dockerfile` added |
| 2 | `infra/seed.mjs` | ✅ **25 M txns, 5891 MB** (skip-if-exists unless `--force`) |
| 3–7 | IR, introspect, hash, branches, commits | ✅ |
| 8–20 | diff → UI → pre-flight | ✅ |
| 21 | remaining tests | ✅ **91 tests / 16 files** — `canonical`, `branch`, `pipeline` added |
| 22 | deploy | ⚠️ compose + systemd units ready; **no named tunnel / public URL** |
| 23 | lock proof | ✅ `infra/proof.mjs` → `infra/proof-results.md` + SVG chart |
| 24 | decisions + README + video | ⚠️ `decisions.md` + `README.md` written; **demo video not recorded** |

**Verify:**

```bash
docker compose up -d db
cd api && npm run build
cd api && npx vitest run          # 91 tests across 16 files
curl http://localhost:3001/api/health
# or the compose stack (ports remappable):
API_PORT=18080 WEB_PORT=18081 docker compose up --build -d
curl http://localhost:18080/api/health
curl http://localhost:18081/
node infra/proof.mjs
```

Current dataset: `main.txns` **25,000,000 rows / 5891 MB**, plus accounts (200k),
cards (400k), merchants (20k), disputes. Catalog size about **6.3 GB**.

`main` HEAD was healed to hash `ea5ea44a…` (all five seeded tables) and
`base_commit` matches. `/api/demo/reset` now restores that seed snapshot, not
the stale two-table root commit. Do not auto-heal in `bootstrap` — tests create
probe tables on `main`.

---

## Assignment scorecard (problem 2)

Must-haves from `sources/assignment-notion-copy.md`:

| Requirement | State |
|---|---|
| Web app that applies changes to a real DB | ✅ branch → DDL → commit → validate → apply → revert proven on `accounts` |
| Works on ~5 GB | ✅ 25 M rows / 5.9 GB; branch 21 ms; browse `txns` 459 ms; NOT NULL probe 500k hits |
| Branch / diff / merge + the eight ops | ✅ engine + parser whitelist |
| `decisions.md` | ✅ |
| GitHub repo | ✅ `origin` exists |
| **Deployed URL we can test** | ❌ named tunnel not configured — this is the only hard assignment miss |
| Demo video | ❌ not required by the brief, useful hedge |

Hard problems already owned (the “above and beyond” depth):

- View-branch over 5 GB (no copy)
- `lock_timeout` + FIFO lock-queue proof
- Expand / sync-trigger / backfill / cutover + resume
- Pre-flight against real rows (memo NOT NULL, email UNIQUE)
- Manual contract + lossless revert

Just fixed on the working path:

- Stale `main` HEAD made every new branch look like `DROP TABLE cards/disputes/merchants`
- UI Apply/Revert sent `Content-Type: application/json` with an empty body → Fastify 400
- UNIQUE probe counted NULL groups; Postgres does not

## Do this next, in order

1. **Named tunnel (the assignment’s #1 line).** Cloudflare named tunnel or
   Tailscale Funnel. Fill `infra/systemd/gitdb-tunnel.service`. Reboot-test.
2. **Disable suspend** if that URL is the submission.
3. Next hard slices, if time: a watched 5 GB rewrite through the UI; archive-on-contract
   stays gated; rename confirmation is still raw JSON.
4. **Demo video** (`PLAN.md` §9) then commit sources only.

---

## Things discovered while building that aren't in BUILD.md

**`CREATE OR REPLACE VIEW` cannot rename or drop columns** (`42P16`). Every view write is
`DROP VIEW IF EXISTS` then plain `CREATE VIEW`. `createViewSQL()` emits the plain form on
purpose.

**Bound parameters make `generate_series` ambiguous.** Cast explicitly (`${lo}::bigint`).

**Primary-key indexes are skipped during introspection** (`indisprimary`). Emitting both
would duplicate ops in every diff.

**`vitest` is v5.** `npm audit` was clean — keep it that way.

**`main` is immutable except through merges.** `applyIR()` throws if you target `main`.

**Task 8 rename vs Task 10 suggestions.** `diff()` emits `rename_column` only when the `to`
column's `physicalName` still names the old backing column (branch-view rename). At-rest
IRs (`physicalName === name`) with `amount_cents` vs `amount` are drop+add; Task 10 suggests
the rename. Never auto-apply the heuristic.

**`classify` has no `ctx` yet.** Everything it needs is on the `SchemaOp`. Volatile defaults:
any function call (and `CURRENT_TIMESTAMP`-style keywords) → `REWRITE`. Unknown functions
are volatile on purpose.

**`merge()` returns `diff(ours, merged)`** — ops to apply onto the target (`main`). Paths:
`table`, `table.column`, `table.constraint.name`, `table.index.name`. `validated`-only
constraint changes are ignored by `diff()` (no VALIDATE op).

**`guardedDDL` test** uses `main.gitdb_lock_probe`, not `txns`. It holds `AccessShareLock`
in a second connection, asserts a SELECT on *that same transaction* returns in < 50 ms,
and expects `CouldNotAcquireLock` after 3 attempts. Do not call `closeAll()` from unit
tests — the test file owns its own `postgres()` clients and `end()`s them in `afterAll`.
The `sql` singleton in `db.ts` must not be closed by this test (it would break the process).

**Lock-timeout code is `55P03`.** Helper: `isLockNotAvailable` in `db.ts`.

**Runner state is restart-safe.** `persistPlan()` does not reset non-pending rows;
`runMerge()` skips `done`/`skipped`, retries the first other row, dispatches long work
to its worker connection, and never executes `manual`/`contract` rows.

**Dependency recursion must track visited view OIDs.** `pg_rewrite` exposes a view's own
rewrite dependencies; recursive traversal without an OID path loops forever. `deps.ts`
cross-checks every dependent schema against `gitdb.branches` before touching DDL.

**Backfill progress has two meanings.** `cursor` is the last completed PK range boundary;
`rows_done` is the actual number of rows updated. Both are persisted after every batch.
The race test includes a no-trigger control that leaves a behind-the-sweep row stale.

**CIC owns invalid-index cleanup.** It checks `pg_index.indisvalid` after every attempt,
uses `DROP INDEX CONCURRENTLY IF EXISTS` before retry, and resets its worker-session
`statement_timeout` in `finally`.

**Rewrite cutover keeps a physical backup.** It renames the old column to
`<column>__old_<mergeId>` and the shadow to the logical name. Contract drops only that
backup; revert drops the new column, renames the backup back, and restores NOT NULL.
Ordinary DROP COLUMN/TABLE plan steps are manual contract steps too.

**`gitdb.merge_steps` already has `cursor`** (bigint PK resume point) in `schema.sql` —
use it in Task 15; don't add a parallel mechanism.

**TypeScript:** `consValue().kind` collided with `{ kind: "constraint", ...spread }`
(`TS2783`). Encode merge nodes as `{ k, v }`.

**Task 18 route architecture.** `buildApp()` bootstraps metadata and registers separate
branch, diff, merge, and system route modules. SQL authoring is parsed by libpg-query in
`ir/parse.ts`; DML and non-whitelisted DDL fail explicitly. Internal `{ops}` uses the same
IR mutation path.

**Merge execution is globally serialized.** Apply claims a transaction advisory lock,
marks the merge running, then holds the same advisory lock on `workerSql` for runner
execution. A concurrent apply returns
`409 { state: "merge_in_progress", mergeId }`.

**Telemetry is persisted and live.** Runner/backfill/guarded events are inserted into
`gitdb.events`; the WebSocket replays history before subscribing to live events.

**Task 19 UI architecture.** `web/src/App.tsx` is a merge-centred operations console with
branch navigation, semantic split diff, real-data browser, SQL-only DDL editor, compiled plan,
and live WebSocket telemetry. It explicitly renders first-run, empty, in-progress, conflict,
and failure states. Shared `SchemaIR`/`SchemaOp` types are imported from `@gitdb/api`.

**Read-only browsing routes.** `GET /api/branches/:name/stats` returns catalog row estimates
and storage (branch views report 0 bytes); `GET /api/branches/:name/tables/:table/rows?limit=`
validates the table against the branch IR, quotes identifiers, and runs in a read-only
transaction. The latter returns an exact row count plus up to 100 real rows.

**Declared constraints live in `gitdb.branches.working_ir`.** Views cannot hold constraints
or indexes, so catalog introspection would drop them. `applyIR` now persists the full
working-tree IR; `workingIR()` prefers that JSON over `pg_catalog` for non-main branches.

**Route tests must not apply catalog-derived plans while the full suite runs.** Existing
integration files temporarily mutate `main` in parallel. `routes.test.ts` therefore tests
apply/contract/revert refusal with a schema-neutral persisted merge, while engine tests
cover real migration plans.

**`bootstrap()` reads `schema.sql` next to the compiled file.** The API build copies
`src/vcs/schema.sql` → `dist/vcs/schema.sql`. There is an `ENOENT` fallback to `src/`.

**Alpine `wget` resolves `localhost` to IPv6.** Web healthchecks must use `127.0.0.1`.

**`seed.mjs` is destructive unless skipped.** It now exits 0 when `main.txns` already
has rows. Compose `seed` therefore cannot wipe the 25 M-row volume. `--force` rebuilds.

**Compose host ports 8080 and 5173 collide with local `tsx` / Vite on this machine.**
Override with `API_PORT` / `WEB_PORT`. Inside the compose network the API is always `:8080`.

---

## Decisions already locked — don't relitigate

- SQL editor, not a form. Bundled database only.
- Primary user = platform engineer; **merge preview is the centre**.
- Branch constraints: declared, not enforced. Badge *"declared — enforced on merge"*.
- Contract is manual. Merges target `main` only.

---

## Known gaps in what's built

- No public HTTPS URL. systemd units are written, not installed. No tunnel binary
  (`cloudflared` / `tailscale` / `ngrok`) is on this host.
- Demo video is not recorded.
- `branchDDL()` / `regenerateDDL()` overlap `applyIR()`; consolidate when the executor needs them.
- Probes in `api/test/*.probe.ts` are manual; Vitest is the suite (91 / 16).
- SQL authoring deliberately supports the Task 18 whitelist, not every PostgreSQL DDL
  feature (for example expression indexes and schema-qualified authoring are rejected).
- Do not run `node infra/proof.mjs` against `main.txns`. It uses `main.gitdb_proof` and drops it.

---

## Context handoff protocol (project owner request)

When this agent's context is ~80% full: **stop after the current task**, rewrite this file,
and start a **new agent** whose first action is to read `HANDOFF.md`. Do not carry the old
thread's assumptions — the file is the source of truth.
