# decisions.md

A running log of the real calls made building this. Each entry records **the decision**, the
**alternatives** seriously considered, the **reasoning** including trade-offs accepted, and
**what was deliberately cut**.

Entries 1–15 were made during design and are each backed by a measurement, not an opinion.
Entries 16–21 are product and deployment calls. Entries 22–27 were made once the merge
engine existed and the remaining hard edges showed up in the demo: rewind, branch-to-branch
integrate, leftover expand columns, and resetting a 25 M-row catalog.

### How I framed the problem

The brief is “version control for database schemas” against a real ~5 GB Postgres. I read
that as: **branch the live catalog, change it, and merge without freezing the application**.
Not a dump-and-diff registry, not Flyway scripts, not Dolt. The hard part is not generating
`ALTER TABLE` — it is applying `REWRITE` changes to 25 million rows while readers keep
running, and undoing a merge without inventing a second migration engine.

That framing decides almost everything below: views instead of copies, catalog IR instead
of text, expand-and-contract instead of in-place rewrites, contract as a separate
destructive action, rewind as one forward plan rather than N reverse replays.

### How the numbers were produced

Before writing product code, I stood up Postgres 17 in Docker and built a real 20 M-row /
4 GB transactions table to test the core hypotheses. Every number in entries 1–15 came from
that harness (20-core machine, NVMe, `shared_buffers=2GB`). `infra/seed.mjs` reproduces the
dataset; the lock proof is `infra/proof.mjs`. Where a claim has no number, I say so.

---

## 1. The problem is locks, not SQL

**Decision.** Treat this as a concurrency-control problem, not a DDL-generation problem. The
entire architecture is organised around never holding a long lock on a large table.

**Alternatives.** Generate migration SQL and hand it to the user (what most schema-diff tools
do). Apply DDL directly and accept brief downtime.

**Reasoning.** The brief requires applying changes to a real 5 GB database, and at that size
the naive path doesn't merely get slow — it takes the application down. Postgres grants locks
FIFO, so a queued `ALTER TABLE` blocks every query arriving behind it, even ones that don't
conflict with anything currently running.

I reproduced this: with one long-running reader holding `AccessShareLock` on the 4 GB table, I
fired an unguarded `ALTER TABLE`. A trivial `SELECT id WHERE id = 1` — normally ~3 ms — **blocked
for 3,098 ms and then timed out**. The table was effectively frozen by a statement that had not
started executing. That is the failure this tool exists to prevent.

**Cut.** Any code path that issues DDL without a lock guard. There is exactly one exception
(`CREATE INDEX CONCURRENTLY`, entry 14), and it has its own path.

## 2. `lock_timeout` with exponential backoff, on every DDL statement

**Decision.** Every DDL statement runs inside `SET LOCAL lock_timeout = '500ms'` and retries
with jittered exponential backoff, up to 15 attempts.

**Alternatives.** No timeout (entry 1's disaster). A long timeout, hoping the lock frees.
A maintenance window — unavailable to a generalised tool that can't dictate the host's schedule.

**Reasoning.** The migration should fail rather than make the application fail. With the same
competing reader in place, the guarded version of the identical `ALTER TABLE` **aborted cleanly
in 605 ms**, and no application query was ever blocked. Retrying with backoff then lands the
change in the first quiet moment. The trade-off accepted: a migration can fail to apply under
sustained load, which I consider strictly better than the alternative.

**Cut.** Forcing the lock by terminating competing backends. A schema tool should not decide
that its work outranks someone's running query.

## 3. Branch via views, not copy-on-write storage

**Decision.** A branch is a Postgres schema containing one view per table in the parent.
No data is copied.

**Alternatives.** Copy-on-write storage branching (Neon). Database-per-branch. `CREATE DATABASE
… TEMPLATE`. Schema-only branches with empty tables.

**Reasoning.** CoW is the technically ideal answer and the reason Neon can branch instantly,
but it requires owning the storage engine — not buildable here, and it would mean shipping a
database rather than a tool that works with yours. Database-per-branch costs 5 GB per branch
and burns a connection pool per branch.

Schema-only branches (empty tables) were the tempting shortcut, and I rejected them because
they make the tool much less useful: you cannot validate a constraint, estimate a migration, or
test a query against an empty sandbox. The whole point of branching a *real* database is the
data.

Measured: creating a branch over the 4 GB table takes **4 ms and occupies 0 bytes**. The branch
returns all 20 M rows and is writable.

The risk was performance, since every branch query goes through a view. It doesn't materialise:
Postgres inlines simple views, so predicates push through to the base table's indexes. A point
lookup through a branch view ran in **0.009 ms** as a real index scan, and a full aggregate took
**956 ms through the view versus 962 ms directly** — inside noise. That holds even for a branch
with added, dropped, renamed and retyped columns.

**Cut.** Branching data (row-level). Branches share physical rows with `main`; see entry 13.

## 4. Diff the catalog, not the text

**Decision.** Introspect `pg_catalog` into a canonical typed intermediate representation and
diff that. `libpg-query` is used only to parse user-authored DDL into the same IR.

**Alternatives.** `pg_dump` plus text diff. Parsing dump output into an AST and tree-diffing it
(GumTree-style).

**Reasoning.** Text diffing SQL is fragile in well-known ways: `varchar(255)` and `character
varying(255)` are identical to Postgres but differ as strings, and reordering column definitions
changes nothing physically while looking like a large diff. The usual fix is AST diffing — but
that fix is aimed at the wrong target here. `pg_catalog` is *already* a parsed, normalised,
authoritative representation. The database did the parsing. Round-tripping through `pg_dump`
text only to re-parse it reintroduces the fragility.

So the IR comes from the catalog, and the diff is a plain structural comparison over my own
types — deterministic, and unit-testable without a database, which is why it has the densest
test coverage in the project.

For the one place text does enter — the user typing DDL — I use `libpg-query`, which embeds
`libpg_query`, the genuine PostgreSQL C parser. Verified: `varchar(255)` and `character
varying(255)` both canonicalise to `pg_catalog.varchar`, and `int` and `integer` both to
`pg_catalog.int4`. Semantic equivalence comes free rather than being hand-coded.

**Cut.** Support for schema objects outside the brief's list: stored procedures, partitions,
materialised views, user-defined types. They are rejected loudly at introspection rather than
silently ignored.

## 5. State-based versioning, not migration-based

**Decision.** Each commit stores a full snapshot of the schema IR, content-addressed by
`sha256(canonicalJSON(ir))`. Migrations are computed by diffing states, not authored by hand.

**Alternatives.** Migration-based versioning (Flyway, Rails): ordered, hand-written scripts.

**Reasoning.** Migration-based is simpler to build but wrong for a *branching* tool: to merge
two branches you must reconcile two divergent script sequences, which has no well-defined
answer. Diffing declared states does have one.

It also makes rewinding cheap. Because commits are snapshots rather than deltas, going back five
commits is a single `diff(HEAD_ir, commit_N_ir)` compiled into one forward migration — not five
reverse replays. That is now the rewind path (entry 23).

Content addressing gives commit deduplication and a Merkle history for free.

**Cut.** A full commit DAG with lowest-common-ancestor traversal *for merges into main*.
Each branch stores `base_commit` at creation, so a three-way merge onto `main` is an O(1)
lookup that still catches the interesting case — main moved while you were branched.
Branch-of-a-branch was cut as a parent for `CREATE BRANCH`. LCA came back later, only for
branch-to-branch integrate (entry 22).

## 6. Expand-and-contract — forced on us, and correct anyway

**Decision.** No `REWRITE`-class change is applied in place. Add a new column, backfill it in
batches, validate, swap the views, and only later drop the old column.

**Alternatives.** Direct `ALTER TABLE`. Trigger-based shadow tables (`pt-online-schema-change`).
Triggerless binlog streaming (`gh-ost`). Stripe's dual-write pattern.

**Reasoning.** I expected to argue for expand-and-contract on its merits. Instead Postgres
removed the choice: `ALTER COLUMN TYPE` fails outright with `cannot alter type of a column used
by a view or rule`. Since every branch is a view over `main`, any open branch blocks in-place
type changes. The workaround — drop dependent views, alter, recreate — **took 23,986 ms holding
`AccessExclusiveLock`** on the 4 GB table. A 24-second outage.

So the constraint pushed the design where it should have gone anyway.

On the alternatives: `pt-online-schema-change`'s triggers mirror every write into a full shadow
table, which is real write amplification on the primary. `gh-ost` avoids that by reading the
binlog, but it is MySQL-specific and a binlog parser is not a five-day component. Stripe's
dual-write requires changing the application, which a generalised database tool cannot assume it
can do.

**Cut.** In-place `ALTER TABLE` for anything classified `REWRITE`.

## 7. Not every operation needs a helper column

**Decision.** `SET NOT NULL` uses `ADD CONSTRAINT … CHECK (col IS NOT NULL) NOT VALID` →
`VALIDATE CONSTRAINT` → `SET NOT NULL`, with no new column and no backfill.

**Alternatives.** Route every constraint change through the full expand/backfill/contract
machinery, as `pgroll` does for some operations.

**Reasoning.** Uniformity is tempting but wasteful. Adding `NOT NULL` doesn't change any
*value*, so duplicating the column copies 5 GB to achieve nothing. The naive `SET NOT NULL`
measured **2,670 ms of `AccessExclusiveLock`** because it scans to verify. The three-statement
path avoids that: `NOT VALID` is instant metadata, `VALIDATE CONSTRAINT` takes only
`ShareUpdateExclusive` and blocks neither reads nor writes, and from PostgreSQL 12 onward
`SET NOT NULL` recognises the validated constraint and skips the scan entirely.

Column duplication is reserved for operations where values actually change.

**Cut.** A uniform pipeline. The plan compiler picks per operation, which costs a classification
table but saves minutes per migration.

## 8. One trigger, after rejecting triggers

**Decision.** During a backfill, install a `BEFORE INSERT OR UPDATE` trigger that keeps the new
column in sync with the old. Drop it at cutover.

**Alternatives.** No trigger, and re-sweep at the end. Lock writes during the backfill. Accept
the gap.

**Reasoning.** This looks like a contradiction of entry 6, and it isn't. Without it there is a
silent correctness bug: any row the application writes *after* the backfill sweeps past its
primary key keeps a NULL in the new column, and cutover exposes a column with holes. A final
re-sweep only narrows the window; it cannot close it.

Rejecting an *architecture* is not the same as refusing a *mechanism*. `pt-online-schema-change`
mirrors every write into a separate shadow table — that's where its cost comes from. This trigger
assigns one column on a row already being written, in the same buffer, in the same transaction.
Different cost class entirely.

I consider this the most important correctness decision in the project, because the bug it
prevents would have passed a casual demo.

**Cut.** Nothing. There is a test that removes the trigger and asserts the failure.

## 9. Contract is manual, and that is the feature

**Decision.** A merge finishes at state `merged, reversible`. Dropping the old column is a
separate action the user must take.

**Alternatives.** Auto-contract at the end of a merge. Auto-contract after a timer.

**Reasoning.** Contract is the only destructive step in the system. Before it runs, reverting is
free — the old column is untouched, so you point the views back and drop the new one. After it
runs, the data is gone.

Making it manual costs one nullable timestamp (`merges.contracted_at`) and turns the design's
sharpest limitation into a visible safety property. The UI frames it as *"permanently drop
`amount_cents`, reclaim ~1.2 GB"* rather than hiding it.

**Cut.** Automatic cleanup. Users will accumulate dead columns; that is the correct default when
the alternative is irreversible data loss, and the UI surfaces the reclaimable space.

## 10. Reversibility has three tiers; we ship one and design the second

**Decision.** Ship the lossless pre-contract window. Design archive-on-contract as a bolt-on and
leave two hooks for it. Reject row-level time travel.

**Alternatives.** Archive every dropped column automatically (~7 h, plus roughly 1 GB of disk per
archived `bigint` column on 25 M rows). Full row-versioning, Dolt-style.

**Reasoning.** Row-level time travel is rejected on principle rather than on time. Retaining
every row version means either temporal columns with triggers on every write, or logical-
replication capture into an unbounded history table. Both put write amplification on the hot
path, which destroys the property the entire design depends on — that branching is free. Dolt
solves this properly and needed a custom storage engine (prolly trees) to do it. That is a
different product, not a missing feature here.

Archive-on-contract is the sensible middle, and one property makes it cheap: by contract time
the old column is *orphaned* — no view exposes it, so nothing can write to it. It is frozen,
meaning the archive copy needs no sync trigger, unlike the forward backfill. Two hooks keep it
buildable later: `physicalName` on every IR column, and `merges.contracted_at`. Both cost
minutes now and are genuinely painful to retrofit, since by then the history is lost.

**Cut.** Both tiers above the window, for this iteration. Rewind (entry 23) is not a
substitute for archive-on-contract: it restores schema, and reconstructible values, not
bytes that contract already dropped.

## 11. Renames are ambiguous, so we ask

**Decision.** Detect likely renames heuristically, then require explicit user confirmation.
Never apply one automatically.

**Alternatives.** Silent heuristic detection. No detection — always drop plus add.

**Reasoning.** The asymmetry decides it. A rename correctly detected saves a backfill. A
drop-plus-add wrongly collapsed into a rename produces a confusing diff. But a *rename* wrongly
read as drop-plus-add **destroys a column of data**. With stakes that lopsided, a confirmation
prompt beats a clever heuristic. It's also better product behaviour: the user knows what they
meant, and asking takes one click.

**Cut.** Cross-table rename detection, and table renames.

## 12. Contract is blocked while a branch depends on the column

**Decision.** Because I own every view in the system, the dependency resolver reads my own
branch registry rather than `pg_depend` (cross-checking `pg_depend` defensively). When `main`
drops a column a branch still selects, that branch is regenerated where possible, or marked
stale with a readable reason.

**Alternatives.** Cascade-drop dependent views. Refuse the merge entirely.

**Reasoning.** Postgres refuses the drop while dependent views exist, so this surfaces loudly
rather than silently — good. Cascading would silently break other people's branches. Refusing
outright makes the tool unusable once more than one branch is open. Regenerate-or-mark-stale
keeps both properties, and *"branch `feature-x` is stale: main dropped `memo`, which this branch
references"* is an error message someone can act on.

**Cut.** Automatic rebasing of stale branches onto new `main`.

## 13. Branch constraints are declared, not enforced

**Decision.** Constraints and indexes declared in a branch are recorded in the IR, validated
against real data, and created only at merge. They are not enforced inside the branch.

**Alternatives.** Enforce via `INSTEAD OF` triggers on the branch views. Forbid declaring them in
a branch at all.

**Reasoning.** Postgres cannot attach a constraint or an index to a view, so enforcement would
require hand-written trigger logic. More fundamentally, it would be *incoherent*: branches share
physical storage with `main`, so a write through a branch view lands in `main`'s rows. If branch
A enforced `memo NOT NULL` while branch B required `memo IS NULL`, they would be contending over
identical physical rows and neither could be satisfied.

Declaring intent is therefore the only correct behaviour, and it is consistent with the
state-based model in entry 5 — a branch holds a *desired state*, exactly as a Terraform file
does; nothing is enforced until apply.

It is also more useful. A sandbox that rejects your test insert tells you nothing. This tells you
*"1,284,993 of your 25 million real rows would violate this"* before you merge, which is only
possible because branches see real data (entry 3). The UI badges these as *"declared — enforced
on merge"* so the behaviour is never surprising.

**Cut.** `INSTEAD OF` trigger enforcement. It would also break the auto-updatable views that make
branches writable.

## 14. `CREATE INDEX CONCURRENTLY` gets its own path

**Decision.** Index creation bypasses the standard guarded-DDL wrapper and runs on a dedicated
non-transactional path with invalid-index cleanup.

**Alternatives.** Blocking `CREATE INDEX`. Forcing it through the transactional wrapper.

**Reasoning.** Blocking index creation measured **6,316 ms** on 20 M rows and locks out writes
throughout. `CONCURRENTLY` takes only `ShareUpdateExclusive` and blocks no writes — but it cannot
run inside a transaction block, so it structurally cannot use the guarded wrapper, which wraps
everything in `BEGIN`. It also leaves an *invalid* index behind if it fails, which must be
detected via `pg_index.indisvalid` and dropped before retrying.

This is a genuine exception to entry 2's invariant, so it is written down rather than discovered.

**Cut.** Index types beyond btree.

## 15. TypeScript, over Go and Python

**Decision.** TypeScript end to end — Fastify API, migration worker, React UI.

**Alternatives.** Go with `pg_query_go`. Python with FastAPI and `pglast`.

**Reasoning.** The obvious argument for Go was parser fidelity, and checking dissolved it:
`pg_query_go`, `pglast` and `libpg-query` are all bindings over the *same* `libpg_query` C
library. I verified the Node binding produces identical canonicalisation to the Python one. There
is no fidelity advantage anywhere.

With that gone: Go adds compile-time safety but costs cgo build friction and hand-walking deeply
nested protobuf parse trees. Python has the best ergonomics but gives up static typing on the IR,
which is the backbone of this system. TypeScript uniquely gets the real parser, static types on
the IR, *and* one language across API, worker and UI — `SchemaIR` is literally the same type on
both sides of the wire, with no codegen step. For a solo build under a deadline, that mattered
more than anything else. I am also fastest in it, which is a legitimate engineering input at this
timescale.

**Cut.** A second language anywhere in the stack.

## 16. Self-hosted deployment over a managed platform

**Decision.** Host the stack on a workstation and expose it through a named tunnel, running the
same `docker-compose.yml` a reviewer runs locally.

**Alternatives.** Managed Postgres (Neon, Supabase). A small cloud VM.

**Reasoning.** Managed free tiers cap at 0.5 GB — twelve times too small for the brief's
constraint, and they don't give enough control to demonstrate lock behaviour. A small VM works
but is slow where it matters: the backfill measured **136 k rows/sec** on this hardware, and on
4 shared vCPUs it would be roughly a third of that, turning a watchable 3-minute migration into a
tedious 10-minute one.

The trade-off accepted is availability — a self-hosted instance is only up when the host is. It
is mitigated honestly rather than hidden: suspend is disabled, both the stack and the tunnel run
as systemd units with `Restart=always`, the README states the constraint plainly, and the demo
video plus one-command local setup mean the submission never depends on the URL being reachable.

Because the deployment artifact *is* the compose file, moving to a cloud VM is a 30-minute change
if it proves necessary.

**Cut.** Multi-tenancy and authentication. Concurrent reviewers are handled with a Postgres
advisory lock serialising merges and a demo-reset endpoint, not with accounts.

## 17. Users author changes as SQL, not through a form

**Decision.** Schema changes in a branch are written as ordinary Postgres DDL in a text
editor, parsed by `libpg-query` into the IR.

**Alternatives.** A structured UI (pick a table, click "add column", choose a type from a
dropdown). A hybrid with form shortcuts over a SQL editor.

**Reasoning.** The audience already writes DDL; a dropdown is slower than typing
`ALTER TABLE txns ADD COLUMN settled_at timestamptz`, and it silently caps expressiveness at
whatever the form designer anticipated. A form would also have been the *easier* build — it
needs no parser — so this is a deliberate choice to be more useful rather than less work.

It costs nothing extra in dependencies: `libpg-query` is already present for type
canonicalisation (entry 4), and because it embeds the real PostgreSQL C parser, anything
Postgres accepts parses correctly. Unsupported-but-valid DDL is rejected explicitly against
the whitelist rather than mis-parsed.

The trade-off accepted is discoverability, mitigated by seeding the editor with worked
examples per risk class so the empty state teaches the tool.

**Cut.** Form-based editing entirely. Also cut: executing arbitrary DML through the editor —
it accepts schema DDL only.

## 18. One bundled database, not bring-your-own

**Decision.** The tool manages the Postgres instance it ships with, seeded to ~5 GB.

**Alternatives.** Accept a user-supplied connection string. Bundled by default with BYO as an
option.

**Reasoning.** The brief asks for a product that applies changes to a real database so it can
be tested end to end, and a bundled instance delivers that with zero setup — a reviewer gets a
populated 5 GB database on first load rather than having to supply one.

Bring-your-own looks like a small addition and isn't. It means credential handling, permission
discovery (the view-based design needs `CREATE SCHEMA` and ownership of every target table),
introspecting arbitrary schemas full of objects outside the whitelist, and degrading
gracefully when any of that is missing. That is a meaningful amount of work spent away from
the hard part of the problem.

**Cut.** Connection management, credential storage, and multi-database support. The
architecture doesn't preclude it — `introspect(schema)` and the view generator take a schema
name already — so it is a later addition, not a rewrite.

## 19. Built for the platform engineer, usable by the app developer

**Decision.** The primary user is a platform or infrastructure engineer responsible for
shipping a schema change to production without an incident. The secondary user is an
application developer who wants to try a change against real data. The primary wins wherever
they conflict.

**Alternatives.** Target the app developer first, which would have meant optimising for
sandbox ergonomics over migration safety.

**Reasoning.** The two want different default screens. The app developer wants to branch and
start editing. The platform engineer wants to see what a change will *cost* before it runs —
lock class, backfill duration, how many real rows violate a new constraint.

The primary choice drives concrete decisions: the merge preview (not the SQL editor) is the
centre of the product; every operation carries a visible risk badge; live telemetry during a
migration is a first-class surface rather than a progress spinner; and contract is a separate,
explicitly labelled destructive action (entry 9).

The secondary user is served nearly for free, because a branch over real data is a good
sandbox whether or not you care about lock classes.

**Cut.** Collaboration features — comments, approvals, review workflows — which the platform
engineer would plausibly want next but which add surface area rather than depth.

## 20. What was deliberately left out

- **Row-level data diff and merge.** The brief versions *schemas*. Versioning data is a different product (entry 10).
- **Row-level time travel.** Rejected on principle — write amplification on the hot path (entry 10).
- **Archive-on-contract.** Designed (entry 10), not shipped. After contract, dropped-column bytes stay gone unless they can be recomputed from columns that remain.
- **Creating a branch from a branch.** `CREATE BRANCH` is from `main` only. Feature branches can still integrate into each other (entry 22).
- **Authentication, multi-tenancy, multiple target databases.** No bearing on the hard part.
- **Non-Postgres engines.** The whole design leans on logical schemas, `NOT VALID` constraints and cheap `ADD COLUMN`. MySQL would need a different architecture, not a driver swap.
- **Exotic schema objects** — procedures, triggers-as-schema, partitions, materialised views. Rejected loudly at introspection rather than silently mishandled.
- **Bring-your-own Postgres.** The tool ships the instance it migrates (entry 18).
- **Form-based schema editing.** Users write DDL (entry 17).

## 21. Where this design ends

Worth stating plainly, since every design has a scale at which it stops working.

**Around 500 GB**, the backfill stops being the bottleneck and bloat does: one full-table
rewrite measured **4 GB → 8.5 GB**, and `DROP COLUMN` at contract only marks the column dropped —
the file never shrinks without `VACUUM FULL` or `pg_repack`, both of which take
`AccessExclusiveLock` and defeat the purpose. At that size you need `pg_repack` in a maintenance
window, or partitioning.

**Around 50 concurrent branches**, view regeneration during a merge becomes the slow step, since
every dependent view is dropped and recreated in one transaction. It would need incremental
regeneration.

**Across regions**, `lock_timeout` retries interact badly with replication lag, and cutover would
need to be coordinated rather than a single local transaction.

**On this demo catalog**, rewind and reset must not “heal” `txns` with a 25 M-row rewrite
(entries 24 and 27). That is a product bound, not a Postgres bound.

---

## 22. Branch-to-branch integrate walks ancestors; merge to `main` does not

**Decision.** `CREATE BRANCH` still parents only from `main`. Copying a committed schema
onto another *feature* branch (`POST /api/branches/:name/integrate`) does a lowest-common-ancestor
three-way merge of IRs, rewrites the target’s views, and never runs the physical expander.

**Alternatives.** Keep the entry-5 cut and refuse branch-to-branch work. Allow `CREATE BRANCH`
from a branch, which needs the same walk plus a defined merge-to-main story for nested
parents. Merge feature branches onto `main` through the same integrate path.

**Reasoning.** Two people branching from `main` and wanting each other’s schema is the
common case; nested branch creation is not. Integrate is schema-only — no rows are copied,
no lock is taken on `main`, contract never runs — so it cannot accidentally migrate
production. Merge-to-`main` stays the one path that may backfill 25 million rows.

`base_commit` remains the O(1) merge base for `main`. LCA is used only when both sides
have moved off that original parent.

**Cut.** Branch-of-a-branch as a `CREATE BRANCH` parent. Automatic rebase of stale branches
(entry 12) still stands.

## 23. Rewind is one forward plan, not N reverse migrations

**Decision.** Moving `main` back N merge commits is `diff(HEAD_ir, ancestor_ir)` compiled
through the same expand → sync → backfill → cutover runner as a forward merge. It is not
WAL replay, and it is not “run each merge’s plan backwards.”

**Alternatives.** Parse Postgres WAL / a logical decoding stream and undo tuples. Store a
reverse plan next to every merge and replay those in order. `pg_dump` the ancestor and
restore it.

**Reasoning.** Entry 5 already paid for this: commits are snapshots, so five steps back is
one structural diff, not five inverse scripts. WAL undo would reconstruct row history this
tool has explicitly refused to version (entry 10), and a 5 GB restore is the opposite of
online. A stored reverse plan goes stale the moment contract drops a column or a later
merge retypes the same path.

The trade-off accepted: rewind restores **schema**, plus values that can still be computed
from columns that remain. After contract, dropped-column bytes are gone. That is the same
honesty as entry 9, applied backwards.

**Cut.** Point-in-time row restore. Binlog/WAL-based rewind. Auto-running `drop_table` /
`drop_column` for user objects — those stay manual contract steps, as on a forward merge.

## 24. Rewind diffs committed HEAD, not the live catalog

**Decision.** The rewind plan is `diff(head_commit.ir, ancestor.ir)`. Leftover expand
columns (`col__old_<mergeId>`, `col__new`) are dropped as ordinary DDL at the end of
the plan. Unrelated catalog drift — a `txns` retype that never made it into a commit — is
ignored.

**Alternatives.** `diff(introspect(main), ancestor.ir)`, which is what a “make the disk
match the snapshot” tool would do. Sweep *every* extra live column, shadow or not.

**Reasoning.** This was not theoretical. Rewinding an accounts-only retype against the live
catalog compiled a **25 million-row `txns` backfill** because `txns.amount_cents` was still
`numeric(20,2)` from an earlier unfinished rewrite while every commit IR said `bigint`.
The commits being undone touched `accounts.name`. The plan tried to rewrite the credibility
table.

Committed IR vs committed IR answers “undo these commits.” Shadow leftovers are not in any
commit IR — cutover hides them as `physicalName` — so they are appended as executable
`DROP COLUMN` rather than as manual contract. That is the one place rewind *is* allowed to
destroy expand debris: those columns are the migration engine’s, not the user’s schema.

**Cut.** Using rewind as a catalog healer. If live `txns` has drifted from the seed IR,
demo reset (entry 27) also refuses to spend minutes rewriting it.

## 25. Revert, rewind, and contract are three undos, not one button

**Decision.** Until contract, **Revert merge** swaps the retained `__old_*` column back —
lossless, and the right control on the live merge screen. **Rewind** moves `main`’s HEAD
to an ancestor and compiles one schema plan; it will drop leftover shadows. **Contract**
permanently drops retained storage and closes the revert window.

**Alternatives.** One “undo” that always rewinds. Auto-revert when the user picks an
ancestor. Hide contract behind rewind.

**Reasoning.** They are not the same operation. Revert does not change commit history;
rewind does. Revert needs the backup column to still exist; rewind does not, and cannot
resurrect contracted bytes. The UI already had a destructive zone for contract. Adding
“Rewind here” on main history without explaining the difference produced the leftover
`name__old_*` column: rewind had done `ALTER TYPE` in place and left the expand backup
sitting beside `name`.

**Cut.** Silently calling `revertMerge` from rewind when a backup happens to exist. The
plan would then depend on leftover physical names that are not in the commit IR. Rewind
stays a function of commits; revert stays a function of one merge job.

## 26. One advisory lock serialises every physical migration

**Decision.** Merges and rewinds share a single Postgres advisory lock (`MERGE_LOCK`). A
second apply returns `409 { state: "merge_in_progress" }`. The backfill runs on a dedicated
one-connection worker so it cannot starve the request pool.

**Alternatives.** Allow concurrent table-disjoint migrations. Queue in the API process.
No lock, rely on `lock_timeout` alone.

**Reasoning.** Two expand/cutover pipelines on the same database interleave shadow columns,
sync triggers, and view drops. `lock_timeout` protects *readers* from a queued `ALTER`; it
does not protect two writers from each other. The API pool cannot donate a connection for
a 3-minute backfill without stalling health checks and telemetry.

The trade-off accepted: reviewers cannot run two demos at once. Demo reset (entry 27) is
how a second person gets a clean `main`, not a second merge slot.

**Cut.** Per-table locks, a migration queue UI, and killing competing backends (entry 2).

## 27. Demo reset restores the seed snapshot; it does not migrate `txns`

**Decision.** `POST /api/demo/reset` deletes feature branches, fails any running merge,
points `main` at the seeded catalog commit, prunes unreachable commits and all merge jobs,
and drops extra tables plus `__new` / `__old_*` leftovers. It does **not** compile
`diff(live, seed)` through the merge engine.

**Alternatives.** Reset = rewind to seed, including a `txns` retype if live drifted.
`DROP SCHEMA main CASCADE` and re-seed (~100 s and a destroyed demo). Truncate user tables
and keep history.

**Reasoning.** Reviewers share one bundled database (entry 18). Reset has to be fast and
safe to click twice. Running the engine to “make live match seed” hung the first
implementation on `retype_column txns` (~25 M rows) while merge history stayed on screen —
the button appeared to do nothing. Prune + sweep is tens of milliseconds; the seeded 5 GB
of rows stays, because this versions schemas, not a factory-reset of data.

The seed commit is the fullest snapshot (`accounts`, `cards`, `disputes`, `merchants`,
`txns`), not the oldest root. An early two-table commit must never become the reset
target, or reset itself compiles `DROP TABLE` for the extra seed tables.

**Cut.** Using reset as a data wipe. Using reset as a 25 M-row healer. Auth-gated
per-reviewer databases (entry 16).
