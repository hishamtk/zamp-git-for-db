-- gitdb metadata. Idempotent; applied at API boot.

CREATE SCHEMA IF NOT EXISTS gitdb;

-- Content-addressed schema snapshots. id = sha256(canonicalJSON(ir)).
-- Snapshots rather than deltas: rewinding N commits is one diff, not N reverse replays.
CREATE TABLE IF NOT EXISTS gitdb.commits (
  id          text PRIMARY KEY,
  parent_id   text REFERENCES gitdb.commits(id),
  branch      text        NOT NULL,
  message     text        NOT NULL,
  ir          jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gitdb.branches (
  name         text PRIMARY KEY,
  schema_name  text        NOT NULL UNIQUE,
  head_commit  text        REFERENCES gitdb.commits(id),
  -- Captured at branch creation. Makes three-way merge an O(1) lookup instead of
  -- an ancestor walk, and still catches "main moved while you were branched".
  base_commit  text        REFERENCES gitdb.commits(id),
  -- Set when main drops something this branch's views still reference.
  stale_reason text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gitdb.merges (
  id            bigserial PRIMARY KEY,
  source_branch text        NOT NULL,
  source_commit text        NOT NULL,
  target_commit text        NOT NULL,
  base_commit   text        NOT NULL,
  -- Resulting IR, so revert can restore an exact target without recomputation.
  result_ir     jsonb,
  plan          jsonb       NOT NULL,
  -- planned | running | merged | failed | reverted | contracted
  state         text        NOT NULL DEFAULT 'planned',
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  -- NULL means the merge is still losslessly revertible: the old columns survive
  -- until contract, which is the only destructive step and is never automatic.
  contracted_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Persisted so a merge resumes at the right step after a crash or restart.
CREATE TABLE IF NOT EXISTS gitdb.merge_steps (
  merge_id      bigint  NOT NULL REFERENCES gitdb.merges(id) ON DELETE CASCADE,
  seq           int     NOT NULL,
  kind          text    NOT NULL,
  sql           text    NOT NULL,
  -- pending | running | done | failed | skipped
  state         text    NOT NULL DEFAULT 'pending',
  rows_done     bigint  NOT NULL DEFAULT 0,
  rows_total    bigint,
  -- Backfill resume point: the last primary key successfully processed.
  cursor        bigint,
  lock_attempts int     NOT NULL DEFAULT 0,
  ms            int,
  error         text,
  PRIMARY KEY (merge_id, seq)
);

CREATE TABLE IF NOT EXISTS gitdb.events (
  id       bigserial PRIMARY KEY,
  merge_id bigint REFERENCES gitdb.merges(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  level    text NOT NULL,
  payload  jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS events_merge_idx  ON gitdb.events(merge_id, id);
CREATE INDEX IF NOT EXISTS commits_branch_idx ON gitdb.commits(branch, created_at DESC);
