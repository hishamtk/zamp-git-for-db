# HANDOFF — pick up here

**Read order:** this file → `BUILD.md` (the spec) → `PLAN.md` (the why) → `decisions.md`.

Last commit: `882b04f` — *Branch engine: virtual schema overlays over a real database*.
Working tree clean. Postgres is running via `docker compose up -d db`.

---

## Where things stand

`BUILD.md` has 24 tasks. **Tasks 1–7 are done and verified against a live database.**
Nothing is stubbed or mocked — every claim below was measured by running the probes.

| Task | What | State |
|---|---|---|
| 1 | docker-compose, npm workspaces, tsconfig | ✅ `db` service healthy; `api`/`web` services declared but **no Dockerfiles yet** |
| 2 | `infra/seed.mjs` | ✅ works; **currently only a 50 k-row dataset is loaded** — see below |
| 3 | Schema IR types (`api/src/ir/types.ts`) | ✅ incl. `physicalName` hook |
| 4 | Catalog introspector (`api/src/ir/introspect.ts`) | ✅ verified |
| 5 | Canonical JSON + sha256 (`api/src/ir/canonical.ts`) | ✅ verified |
| 6 | Branch engine (`api/src/vcs/branches.ts`, `api/src/engine/views.ts`) | ✅ verified |
| 7 | `gitdb` metadata + commits (`api/src/vcs/`) | ✅ schema applied, `main` + commit 0 seeded |

**Tasks 8–24 are not started.** `api/src/diff/`, `api/src/routes/`, and `web/` don't exist yet.

### Verify the current state in 30 seconds

```bash
docker compose up -d db
npx tsx api/test/introspect.probe.ts   # IR, hashing, type canonicalisation
npx tsx api/test/branch.probe.ts       # branch cost, drift, pushdown, cleanup
```

Expected from `branch.probe.ts` (measured on a 50 k-row table):

```
CREATE BRANCH probe                    6.5 ms
rows visible in branch                 50,000
bytes occupied by branch               0
information_schema.views.is_updatable  YES
apply 4 schema changes to branch       4.8 ms
SELECT id, amount, settled_at id=42 -> { id: '42', amount: '952843.00', settled_at: null }
main.txns still has 7 physical columns
Index Scan using txns_pkey on txns     <- predicate pushdown survives the drifted view
```

If those numbers reproduce, the foundation is sound and the core thesis is proven in code.

### The database currently holds a small dataset

The seed was run with `--rows=50000` for fast iteration. Before any performance work or
demo, load the real thing:

```bash
node infra/seed.mjs --rows=25000000 --accounts=200000   # ~100 s, produces ~5 GB
```

This is destructive — it drops and recreates `main.txns` and `main.accounts`. After
reseeding, delete stale branches and re-run `bootstrap()` so commit 0 matches.

---

## Do this next, in order

**Task 8–10: the diff engine** (`api/src/diff/`). This is the highest-value next piece and
the most test-friendly code in the project — it's a pure function over two IRs with no
database access. `BUILD.md` §Task 8 has the full `SchemaOp` union, §Task 9 the risk
classification table, §Task 10 the rename heuristic.

Write the ~25 Vitest cases **first**. The two that matter most: reordered columns must
produce `[]`, and `varchar(255)` vs `character varying(255)` must produce `[]`. Both
already pass at the IR level (`introspect.probe.ts` proves it), so a failure means the diff
is comparing something it shouldn't.

Then: Task 11 (three-way merge), then Task 12 (`guardedDDL` + the lock-contention test),
then Task 13–17 (the execution engine — the critical path).

Everything you need is already wired: `introspect()`, `hashIR()`, `workingIR()`,
`writeCommit()`, `applyIR()`. The diff engine only needs two `SchemaIR` values.

---

## Things discovered while building that aren't in BUILD.md

These cost time to find. Don't rediscover them.

**`CREATE OR REPLACE VIEW` cannot rename or drop columns.** It fails with
`42P16: cannot change name of view column "amount_cents" to "amount"`, and renaming or
dropping is most of what a branch edit does. Every view write therefore does
`DROP VIEW IF EXISTS` then plain `CREATE VIEW`. `createViewSQL()` deliberately emits the
plain form so a missing DROP fails loudly instead of subtly. Do not "optimise" this back.

**Bound parameters make `generate_series` ambiguous.** `generate_series($1, $2)` throws
`42725: could not choose a best candidate function` because the driver sends untyped
parameters. All call sites in `seed.mjs` cast explicitly (`${lo}::bigint`). Expect the same
in any other multi-overload function you parameterise.

**Primary-key indexes are skipped during introspection.** They're already represented as a
`primary` constraint, and emitting both would make every diff produce a duplicate op. See
the `indisprimary` guard in `introspect.ts`.

**`vitest` was upgraded to v5** to clear five npm audit findings (the vite/esbuild chain).
`npm audit` reports 0 vulnerabilities — keep it that way.

**`main` is immutable except through merges.** `applyIR()` throws if you target `main`
directly. Schema changes reach `main` only via the migration executor, which is the point.

---

## Decisions already locked — don't relitigate

Settled with the project owner; `decisions.md` entries 17–19 record the reasoning.

- **SQL editor, not a form.** Users write DDL; `libpg-query` parses it. No form-based editing.
- **Bundled database only.** No connection-string input, no credential handling.
- **Primary user is the platform engineer** shipping a migration safely; the app developer
  using a branch as a sandbox is secondary. The **merge preview is the centre of the
  product**, not the SQL editor.
- **Branch constraints are declared, not enforced** (`decisions.md` entry 13). The UI must
  badge them *"declared — enforced on merge"*, never render them as live.
- **Contract is manual.** Never auto-chain it onto a merge.
- **Merges target `main` only.** Branch-to-branch is out of scope.

---

## Known gaps in what's built

- `api/Dockerfile` and `web/Dockerfile` are referenced by `docker-compose.yml` but don't exist, so `docker compose up` currently only brings up `db`.
- No Fastify app yet — `api/src/index.ts` is missing, so there is no `/api/health` despite the compose healthcheck expecting one.
- `branchDDL()` and `regenerateDDL()` in `engine/views.ts` overlap with the inline logic now in `applyIR()`. Worth consolidating when the executor needs them; harmless today.
- The two files in `api/test/` are manual probes, not Vitest suites. Real tests start at Task 8.
- Deployment (Task 22) is untouched, and the tunnel choice is still undecided — the project owner deferred it. It blocks nothing until the app runs.
