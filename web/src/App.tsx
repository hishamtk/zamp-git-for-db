import {
  AlertTriangle,
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Database,
  GitBranch,
  Hash,
  Key,
  Link2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Table2,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type Branch,
  type DiffResponse,
  type IntegrateResult,
  type MergeDetail,
  type MergePreview,
  type MigrationStep,
  type Risk,
  type RiskOp,
  type Constraint,
  type Index,
  type SchemaIR,
  type SchemaOp,
  type Table,
  type ValidateReport,
} from "./api";
import { Badge, Button, Card } from "./components/ui";
import { cn } from "./lib/utils";

type Screen = "review" | "data" | "editor" | "diff" | "live";
type Stats = { rowCount: number; sizeBytes: number; exact: boolean };
type Telemetry = Record<string, unknown>;

const EXAMPLE_DDL = `-- Sample type change on accounts (~200k rows).
-- Do not ALTER txns here — that backfills 25 million rows.
ALTER TABLE accounts
  ALTER COLUMN name TYPE varchar(200);`;

const navItems: Array<{ id: Screen; label: string; icon: typeof Database }> = [
  { id: "review", label: "Merge review", icon: Rocket },
  { id: "diff", label: "Semantic diff", icon: Braces },
  { id: "data", label: "Browse data", icon: Table2 },
  { id: "editor", label: "DDL editor", icon: Code2 },
  { id: "live", label: "Live migration", icon: CircleDot },
];

const riskClasses: Record<Risk, string> = {
  SAFE: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  LOCKING: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  REWRITE: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function bytes(value: number): string {
  if (value === 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function opTitle(op: SchemaOp): string {
  switch (op.kind) {
    case "create_table": return `Create table ${op.table.name}`;
    case "drop_table": return `Drop table ${op.table}`;
    case "add_column": return `Add ${op.table}.${op.column.name}`;
    case "drop_column": return `Drop ${op.table}.${op.column}`;
    case "rename_column": return `Rename ${op.table}.${op.from} → ${op.to}`;
    case "retype_column": return `Retype ${op.table}.${op.column}`;
    case "set_nullable": return `${op.nullable ? "Drop" : "Set"} NOT NULL on ${op.table}.${op.column}`;
    case "set_default": return `Change default on ${op.table}.${op.column}`;
    case "add_constraint": return `Declare ${op.constraint.kind} ${op.constraint.name}`;
    case "drop_constraint": return `Drop constraint ${op.constraint}`;
    case "add_index": return `Declare index ${op.index.name}`;
    case "drop_index": return `Drop index ${op.index}`;
  }
}

function opDetail(op: SchemaOp): string {
  switch (op.kind) {
    case "add_column": return `${op.column.type}${op.column.nullable ? " nullable" : " not null"}`;
    case "retype_column": return `${op.from} → ${op.to}`;
    case "set_default": return op.default ?? "no default";
    case "add_constraint": return op.constraint.columns.join(", ") || op.constraint.expression || "";
    case "add_index": return `${op.index.method} (${op.index.columns.join(", ")})`;
    default: return op.kind.replaceAll("_", " ");
  }
}

const constraintKindClasses: Record<Constraint["kind"], string> = {
  primary: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  unique: "border-violet-400/25 bg-violet-400/10 text-violet-300",
  check: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  foreign: "border-sky-400/25 bg-sky-400/10 text-sky-300",
};

function constraintKindLabel(kind: Constraint["kind"]): string {
  if (kind === "primary") return "PRIMARY KEY";
  if (kind === "unique") return "UNIQUE";
  if (kind === "check") return "CHECK";
  return "FOREIGN KEY";
}

function constraintKindShort(kind: Constraint["kind"]): string {
  if (kind === "primary") return "pk";
  if (kind === "foreign") return "fk";
  return kind;
}

function constraintDetail(constraint: Constraint): string {
  if (constraint.kind === "check") return constraint.expression ?? "";
  if (constraint.kind === "foreign" && constraint.references) {
    return `(${constraint.columns.join(", ")}) → ${constraint.references.table}(${constraint.references.columns.join(", ")})`;
  }
  return constraint.columns.join(", ");
}

function shortType(type: string): string {
  return type.replace(/^pg_catalog\./, "");
}

function estimatedStep(step: MigrationStep, rowCount: number): string {
  if (step.kind === "backfill") return `≈ ${Math.max(1, Math.ceil(rowCount / 136_000))}s`;
  if (step.kind === "index_concurrent") return "≈ 7s";
  if (step.kind === "validate") return "≈ 3s";
  if (step.manual) return "manual";
  if (step.risk === "LOCKING") return "< 1s + retries";
  return "< 1s";
}

function RiskBadge({ risk }: { risk: Risk }) {
  return <Badge className={riskClasses[risk]}>{risk}</Badge>;
}

function StatePanel({
  kind,
  title,
  children,
  action,
}: {
  kind: "first" | "empty" | "progress" | "conflict" | "failure";
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Icon = kind === "progress" ? Loader2 : kind === "conflict" ? ShieldAlert : kind === "failure" ? XCircle : kind === "first" ? GitBranch : Check;
  return (
    <Card className={cn(
      "flex min-h-56 flex-col items-center justify-center border-dashed p-8 text-center",
      kind === "conflict" && "border-amber-400/35 bg-amber-400/[.04]",
      kind === "failure" && "border-red-400/35 bg-red-400/[.04]",
    )}>
      <Icon className={cn("mb-4 h-7 w-7 text-muted", kind === "progress" && "animate-spin text-accent", kind === "conflict" && "text-amber-300", kind === "failure" && "text-red-300")} />
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-2 max-w-lg text-sm leading-6 text-muted">{children}</div>
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

export default function App() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [selected, setSelected] = useState("main");
  const [screen, setScreen] = useState<Screen>("review");
  const [schema, setSchema] = useState<SchemaIR | null>(null);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [mainDiff, setMainDiff] = useState<DiffResponse | null>(null);
  const [compareFrom, setCompareFrom] = useState("main");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [merge, setMerge] = useState<MergeDetail | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry[]>([]);
  const [conflicts, setConflicts] = useState<unknown[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  const refreshBranches = useCallback(async () => {
    const next = await api.branches();
    setBranches(next);
    const metrics = await Promise.all(next.map(async (branch) => [branch.name, await api.stats(branch.name)] as const));
    setStats(Object.fromEntries(metrics));
    return next;
  }, []);

  const refreshBranch = useCallback(async (branch: string) => {
    const [{ ir }, nextStats] = await Promise.all([api.schema(branch), api.stats(branch)]);
    setSchema(ir);
    setStats((current) => ({ ...current, [branch]: nextStats }));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const next = await refreshBranches();
        const firstBranch = next.find((branch) => branch.name !== "main")?.name ?? "main";
        setSelected(firstBranch);
        await refreshBranch(firstBranch);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not reach the API");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshBranch, refreshBranches]);

  useEffect(() => {
    if (!merge?.id || screen !== "live") return;
    const id = merge.id;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/merges/${id}/events`);
    socket.onmessage = (message) => {
      const parsed = JSON.parse(message.data) as Telemetry;
      const event = (parsed.payload as Telemetry | undefined) ?? parsed;
      setTelemetry((current) => [...current, event]);
      void api.merge(id).then(setMerge);
    };
    socket.onerror = () => setError("The telemetry stream disconnected. Merge state can still be refreshed.");
    const poll = window.setInterval(() => {
      void api.merge(id).then((next) => {
        setMerge(next);
        if (!["planned", "running"].includes(next.state)) window.clearInterval(poll);
      }).catch((cause) => setError(messageOf(cause)));
    }, 1000);
    return () => {
      socket.close();
      window.clearInterval(poll);
    };
  }, [merge?.id, screen]);

  useEffect(() => {
    if (selected === "main") {
      setDiff(null);
      setMainDiff(null);
      return;
    }
    const from = compareFrom === selected ? "main" : compareFrom;
    void api.diff(from, selected).then(setDiff).catch((cause) => setError(messageOf(cause)));
    void api.diff("main", selected).then(setMainDiff).catch((cause) => setError(messageOf(cause)));
  }, [selected, compareFrom]);

  const chooseBranch = async (name: string) => {
    setSelected(name);
    setCompareFrom("main");
    setPreview(null);
    setMerge(null);
    setConflicts(null);
    setError("");
    try { await refreshBranch(name); } catch (cause) { setError(messageOf(cause)); }
  };

  const firstRun = !loading && branches.every((branch) => branch.name === "main");
  const selectedStats = stats[selected] ?? { rowCount: 0, sizeBytes: 0, exact: false };
  const changeBranches = branches.filter((branch) => branch.name !== "main").map((branch) => branch.name);
  const compareAgainst = ["main", ...changeBranches.filter((name) => name !== selected)];
  const integrateTargets = changeBranches.filter((name) => name !== selected);

  const integrateInto = async (target: string, previewOnly: boolean) => {
    if (selected === "main") return null;
    setBusy(previewOnly ? "integrate-preview" : "integrate");
    setError("");
    setConflicts(null);
    try {
      return previewOnly ? await api.previewIntegrate(selected, target) : await api.integrate(selected, target);
    } catch (cause) {
      if (cause instanceof ApiError && cause.body.state === "conflict") {
        setConflicts((cause.body.conflicts as unknown[]) ?? []);
        return null;
      }
      setError(messageOf(cause));
      return null;
    } finally { setBusy(""); }
  };

  const createBranch = async (name: string) => {
    setBusy("create");
    setError("");
    try {
      await api.createBranch(name);
      await refreshBranches();
      await chooseBranch(name);
      setScreen("editor");
    } catch (cause) {
      setError(messageOf(cause));
      throw cause;
    } finally { setBusy(""); }
  };

  const loadPreview = async () => {
    if (selected === "main") return;
    setBusy("preview");
    setError("");
    setConflicts(null);
    try {
      const next = await api.previewMerge(selected);
      setPreview(next);
      setMerge(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.body.state === "conflict") {
        setConflicts((cause.body.conflicts as unknown[]) ?? []);
      } else setError(messageOf(cause));
    } finally { setBusy(""); }
  };

  const resetDemo = async () => {
    if (!confirm("Reset the demo? This deletes every change branch and restores main to the seeded snapshot.")) return;
    setBusy("reset");
    setError("");
    try {
      await api.resetDemo();
      setPreview(null);
      setMerge(null);
      setConflicts(null);
      await refreshBranches();
      await chooseBranch("main");
    } catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(""); }
  };

  const applyMerge = async () => {
    if (!preview) return;
    setTelemetry([]);
    setMerge({ ...preview, steps: preview.plan.map((step) => ({ ...step, state: "pending", rows_done: 0, rows_total: null, lock_attempts: 0, ms: null })) });
    setScreen("live");
    setBusy("apply");
    void api.applyMerge(preview.id)
      .then(setMerge)
      .catch((cause) => setError(messageOf(cause)))
      .finally(() => setBusy(""));
    window.setTimeout(() => void api.merge(preview.id).then(setMerge), 250);
  };

  return (
    <div className="min-h-screen">
      <header className="flex h-16 items-center justify-between border-b border-border bg-background/85 px-6 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg border border-accent/25 bg-accent/10 font-mono text-sm font-bold text-accent">g/</div>
          <div><div className="font-semibold tracking-tight">gitdb</div><div className="text-[11px] text-muted">database change control</div></div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_#73e2a7]" />
          PostgreSQL 17 · local target
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === "reset"}
            onClick={() => void resetDemo()}
          >
            {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reset demo
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] grid-cols-[260px_1fr]">
        <aside className="border-r border-border bg-[#0d1014] p-4">
          <div className="mb-3 flex items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-[.16em] text-muted">Branches</span>
            <NewBranchButton onCreate={(name) => void createBranch(name).catch(() => undefined)} busy={busy === "create"} />
          </div>
          <div className="space-y-1">
            {branches.map((branch) => (
              <button
                key={branch.name}
                onClick={() => void chooseBranch(branch.name)}
                className={cn("w-full rounded-lg border border-transparent px-3 py-3 text-left hover:bg-white/[.035]", selected === branch.name && "border-border bg-white/[.045]")}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <GitBranch className="h-3.5 w-3.5 text-muted" />{branch.name}
                  {branch.stale_reason && <AlertTriangle className="ml-auto h-3.5 w-3.5 text-amber-300" />}
                </div>
                <div className="mt-2 flex gap-3 font-mono text-[10px] text-muted">
                  <span>{branch.name === "main" ? bytes(stats[branch.name]?.sizeBytes ?? 0) : "0 bytes"}</span>
                  <span>{compactNumber(stats[branch.name]?.rowCount ?? 0)} rows</span>
                </div>
              </button>
            ))}
          </div>
          <div className="my-5 border-t border-border" />
          <nav className="space-y-1">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setScreen(id)}
                disabled={id === "live" && !merge}
                className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-muted hover:bg-white/[.035] hover:text-foreground disabled:opacity-35", screen === id && "bg-white/[.055] text-foreground")}
              >
                <Icon className="h-4 w-4" />{label}
                {id === "review" && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 p-7 lg:p-10">
          <div className="mx-auto max-w-[1280px]">
            <div className="mb-7 flex items-end justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs text-muted">
                  main <ChevronRight className="h-3 w-3" /> <span className="text-foreground">{selected}</span>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">{navItems.find((item) => item.id === screen)?.label}</h1>
              </div>
              <div className="flex items-center gap-5 text-right">
                <div><div className="font-mono text-sm">{compactNumber(selectedStats.rowCount)}</div><div className="text-[11px] text-muted">real rows visible</div></div>
                <div><div className="font-mono text-sm">{selected === "main" ? bytes(selectedStats.sizeBytes) : "0 bytes"}</div><div className="text-[11px] text-muted">{selected === "main" ? "physical target" : "branch storage"}</div></div>
              </div>
            </div>

            {error && <FailureBanner message={error} onClose={() => setError("")} />}
            {loading ? (
              <StatePanel kind="progress" title="Reading database state">Loading branches, catalog IR, and row estimates.</StatePanel>
            ) : firstRun && screen !== "data" && screen !== "editor" ? (
              <FirstRun onCreate={(name) => void createBranch(name).catch(() => undefined)} busy={busy === "create"} onBrowse={() => setScreen("data")} />
            ) : selected === "main" && screen !== "data" && screen !== "editor" ? (
              <StatePanel kind="empty" title="Select a change branch">Main is the protected merge target. Choose a branch to review, diff, or edit.</StatePanel>
            ) : screen === "review" ? (
              <MergeReview
                branch={selected}
                diff={mainDiff}
                preview={preview}
                conflicts={conflicts}
                stats={selectedStats}
                busy={busy}
                integrateTargets={integrateTargets}
                onPreview={loadPreview}
                onApply={applyMerge}
                onIntegrate={integrateInto}
                onIntegrated={(target) => void chooseBranch(target)}
                onEdit={() => setScreen("editor")}
              />
            ) : screen === "diff" ? (
              <DiffView
                from={compareFrom === selected ? "main" : compareFrom}
                to={selected}
                diff={diff}
                compareAgainst={compareAgainst}
                onFromChange={setCompareFrom}
              />
            ) : screen === "data" ? (
              <DataBrowser branch={selected} schema={schema} />
            ) : screen === "editor" ? (
              <Editor
                branch={selected}
                creating={busy === "create"}
                onCreate={createBranch}
                onChanged={async (name = selected) => { await refreshBranch(name); setPreview(null); }}
                onReview={() => setScreen("review")}
              />
            ) : (
              <LiveMerge
                merge={merge}
                telemetry={telemetry}
                onRefresh={() => merge && void api.merge(merge.id).then(setMerge).catch((cause) => setError(messageOf(cause)))}
                onRevert={async () => { if (merge) setMerge(await api.revertMerge(merge.id)); }}
                onContract={async () => { if (merge) setMerge(await api.contractMerge(merge.id)); }}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function NewBranchButton({ onCreate, busy }: { onCreate: (name: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!open) return <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Create branch"><Plus className="h-4 w-4" /></Button>;
  return (
    <div className="absolute left-4 top-20 z-20 w-72 rounded-xl border border-border bg-panel p-4 shadow-2xl">
      <label className="text-xs font-medium">New branch from main</label>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value.toLowerCase())} placeholder="accounts-retype" className="mt-3 h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-accent/50" />
      <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button><Button size="sm" disabled={!name || busy} onClick={() => { void onCreate(name); setOpen(false); }}>Create</Button></div>
    </div>
  );
}

function FirstRun({ onCreate, busy, onBrowse }: { onCreate: (name: string) => void; busy: boolean; onBrowse: () => void }) {
  const [name, setName] = useState("accounts-retype");
  return (
    <StatePanel kind="first" title="Branch the real database in milliseconds" action={
      <div className="flex flex-col items-center gap-3">
        <div className="flex gap-2">
          <input value={name} onChange={(event) => setName(event.target.value)} className="h-10 rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-accent/50" />
          <Button disabled={busy || !name} onClick={() => onCreate(name)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}Create first branch</Button>
        </div>
        <Button variant="ghost" onClick={onBrowse}><Table2 className="h-4 w-4" />Browse main data</Button>
      </div>
    }>
      No change branches yet. Main already holds the live catalog and rows — inspect it first, or create a branch (views over that data, zero copied bytes).
    </StatePanel>
  );
}

function MergeReview({
  branch, diff, preview, conflicts, stats, busy, integrateTargets,
  onPreview, onApply, onIntegrate, onIntegrated, onEdit,
}: {
  branch: string; diff: DiffResponse | null; preview: MergePreview | null; conflicts: unknown[] | null; stats: Stats; busy: string;
  integrateTargets: string[];
  onPreview: () => void; onApply: () => void;
  onIntegrate: (target: string, previewOnly: boolean) => Promise<IntegrateResult | null>;
  onIntegrated: (target: string) => void;
  onEdit: () => void;
}) {
  const [report, setReport] = useState<ValidateReport | null>(null);
  const [integrateTarget, setIntegrateTarget] = useState(integrateTargets[0] ?? "");
  const [integratePreview, setIntegratePreview] = useState<IntegrateResult | null>(null);
  useEffect(() => {
    setReport(null);
    void api.validate(branch).then(setReport).catch(() => setReport(null));
  }, [branch, diff]);
  useEffect(() => {
    setIntegratePreview(null);
    setIntegrateTarget(integrateTargets[0] ?? "");
  }, [branch, integrateTargets.join(",")]);
  if (conflicts) return (
    <StatePanel kind="conflict" title="The two sides conflict" action={<Button variant="outline" onClick={onEdit}>Return to DDL editor</Button>}>
      <p>Both sides changed the same catalog path differently. No resolution was guessed.</p>
      <pre className="mt-4 max-h-48 overflow-auto rounded-lg bg-black/30 p-3 text-left font-mono text-xs">{JSON.stringify(conflicts, null, 2)}</pre>
    </StatePanel>
  );
  if (!diff?.ops.length && !integrateTargets.length) {
    return <StatePanel kind="empty" title="Nothing to merge" action={<Button variant="outline" onClick={onEdit}><Code2 className="h-4 w-4" />Write DDL</Button>}>The branch working tree matches main. Add a schema change to begin a migration review.</StatePanel>;
  }
  return (
    <div className="grid grid-cols-[1fr_360px] gap-5">
      <div className="space-y-4">
        {!!diff?.ops.length && (
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-semibold">Compiled migration plan</h2><p className="mt-1 text-xs text-muted">branch → main · ordered, resumable, lock-guarded</p></div><Badge className="border-accent/25 bg-accent/10 text-accent">{preview ? `${preview.plan.length} steps` : `${diff.ops.length} changes`}</Badge></div>
            {!preview ? (
              <div className="p-8 text-center"><p className="text-sm text-muted">Compile the committed branch into its exact execution plan, risks, and timing.</p><Button className="mt-5" disabled={busy === "preview"} onClick={onPreview}>{busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Preview merge</Button></div>
            ) : (
              <div className="divide-y divide-border">
                {preview.plan.map((step) => <PlanRow key={step.seq} step={step} rowCount={stats.rowCount} />)}
              </div>
            )}
          </Card>
        )}
        {preview && <div className="flex items-center justify-between rounded-xl border border-accent/20 bg-accent/[.055] p-5"><div><div className="text-sm font-semibold">Ready to migrate main</div><div className="mt-1 text-xs text-muted">{report?.blocked ? "Pre-flight found violating rows. Fix the data or the DDL before applying." : "Live telemetry opens before execution starts."}</div></div><Button size="lg" disabled={report?.blocked} onClick={onApply}><Rocket className="h-4 w-4" />Apply {preview.plan.filter((step) => !step.manual).length} steps</Button></div>}
        {!diff?.ops.length && (
          <StatePanel kind="empty" title="Nothing to merge into main" action={<Button variant="outline" onClick={onEdit}><Code2 className="h-4 w-4" />Write DDL</Button>}>This branch matches main. Integrate into another branch, or add a schema change.</StatePanel>
        )}
      </div>
      <div className="space-y-4">
        {!!integrateTargets.length && (
          <Card className="p-5">
            <div className="text-xs font-semibold uppercase tracking-[.14em] text-muted">Integrate into a branch</div>
            <p className="mt-3 text-xs leading-5 text-muted">Copies this branch’s committed schema onto another branch’s views. Main is not migrated. Schema only — no rows are copied.</p>
            <label className="mt-4 block text-[11px] text-muted">Target branch</label>
            <select value={integrateTarget} onChange={(event) => { setIntegrateTarget(event.target.value); setIntegratePreview(null); }} className="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-accent/50">
              {integrateTargets.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <Button
              variant="outline"
              className="mt-3 w-full"
              disabled={!integrateTarget || busy.startsWith("integrate")}
              onClick={() => void onIntegrate(integrateTarget, true).then((next) => { if (next) setIntegratePreview(next); })}
            >
              {busy === "integrate-preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Preview integrate
            </Button>
            {integratePreview && (
              <div className="mt-4 space-y-3 border-t border-border pt-4">
                <div className="text-xs text-muted">{integratePreview.ops.length ? `${integratePreview.ops.length} catalog operation${integratePreview.ops.length === 1 ? "" : "s"} onto ${integratePreview.target}` : `No schema delta — ${branch} adds nothing ${integratePreview.target} does not already have.`}</div>
                {!!integratePreview.ops.length && (
                  <ul className="space-y-1 font-mono text-[11px] text-muted">
                    {integratePreview.ops.map((op, index) => <li key={`${op.kind}-${index}`}>{opTitle(op)}</li>)}
                  </ul>
                )}
                <Button
                  className="w-full"
                  disabled={busy === "integrate"}
                  onClick={() => void onIntegrate(integrateTarget, false).then((next) => { if (next) onIntegrated(integrateTarget); })}
                >
                  {busy === "integrate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
                  Integrate into {integrateTarget}
                </Button>
              </div>
            )}
          </Card>
        )}
        {!!diff?.ops.length && (
          <Card className="p-5"><div className="text-xs font-semibold uppercase tracking-[.14em] text-muted">Impact</div><div className="mt-5 grid grid-cols-2 gap-4"><Metric value={compactNumber(stats.rowCount)} label="rows in scope" /><Metric value={diff.ops.filter((op) => op.risk === "REWRITE").length.toString()} label="rewrites" /><Metric value={diff.ops.filter((op) => op.risk === "LOCKING").length.toString()} label="locking ops" /><Metric value="≤500ms" label="lock attempt" /></div>{report && <div className="mt-5 space-y-2 border-t border-border pt-4">{report.findings.length === 0 ? <p className="text-xs text-muted">No data probes for these ops.</p> : report.findings.map((finding, index) => <p key={index} className={cn("text-xs leading-5", finding.blocked ? "text-red-300" : "text-muted")}>{finding.message}</p>)}</div>}</Card>
        )}
        <Card className="p-5"><div className="flex gap-3"><ShieldAlert className="mt-0.5 h-4 w-4 text-amber-300" /><div><div className="text-sm font-medium">Constraints and indexes</div><Badge className="mt-3 border-violet-400/25 bg-violet-400/10 text-[10px] text-violet-300">declared — enforced on merge</Badge><p className="mt-3 text-xs leading-5 text-muted">Branch declarations do not pretend to constrain shared physical rows.</p></div></div></Card>
        <Card className="border-red-400/20 p-5"><div className="flex gap-3"><Trash2 className="mt-0.5 h-4 w-4 text-red-300" /><div><div className="text-sm font-medium text-red-200">Contract stays manual</div><p className="mt-2 text-xs leading-5 text-muted">Permanent drops never run with a main merge. Integrating another branch never contracts main.</p></div></div></Card>
      </div>
    </div>
  );
}

function PlanRow({ step, rowCount }: { step: MigrationStep; rowCount: number }) {
  return <div className={cn("grid grid-cols-[36px_110px_1fr_90px] items-start gap-3 px-5 py-4", step.manual && "bg-red-400/[.035]")}><div className="grid h-7 w-7 place-items-center rounded-full border border-border font-mono text-xs text-muted">{step.seq + 1}</div><div><div className="text-xs font-semibold uppercase tracking-wide">{step.kind}</div><RiskBadge risk={step.risk} /></div><code className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-[#b8bec7]">{step.sql}</code><div className={cn("text-right font-mono text-xs", step.manual ? "text-red-300" : "text-muted")}>{estimatedStep(step, rowCount)}</div></div>;
}

function DiffView({
  from, to, diff, compareAgainst, onFromChange,
}: {
  from: string; to: string; diff: DiffResponse | null; compareAgainst: string[]; onFromChange: (from: string) => void;
}) {
  const picker = compareAgainst.length > 1 && (
    <div className="mb-4 flex items-center gap-3">
      <label className="text-xs text-muted">Compare against</label>
      <select value={from} onChange={(event) => onFromChange(event.target.value)} className="h-9 rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-accent/50">
        {compareAgainst.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
  );
  if (!diff?.ops.length) {
    return (
      <div>
        {picker}
        <StatePanel kind="empty" title="Catalogs are identical">Column ordering and SQL formatting are ignored. There are no semantic changes between {from} and {to}.</StatePanel>
      </div>
    );
  }
  return (
    <div>
      {picker}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 border-b border-border bg-white/[.02]"><div className="border-r border-border px-5 py-4"><div className="text-xs text-muted">CURRENT</div><div className="mt-1 font-mono text-sm">{from}</div></div><div className="px-5 py-4"><div className="text-xs text-muted">PROPOSED</div><div className="mt-1 font-mono text-sm">{to}</div></div></div>
        <div className="divide-y divide-border">{diff.ops.map((op, index) => <DiffRow key={`${op.kind}-${index}`} op={op} />)}</div>
        {!!diff.renameSuggestions.length && <div className="border-t border-amber-400/20 bg-amber-400/[.04] p-5"><div className="text-sm font-medium text-amber-200">Possible renames need confirmation</div><pre className="mt-2 font-mono text-xs text-muted">{JSON.stringify(diff.renameSuggestions, null, 2)}</pre></div>}
      </Card>
    </div>
  );
}

function DiffRow({ op }: { op: RiskOp }) {
  return <div className="grid grid-cols-2"><div className="min-h-24 border-r border-border bg-red-400/[.025] p-5 text-sm text-muted"><span className="mr-3 font-mono text-red-400/70">−</span>{op.kind.startsWith("add_") || op.kind === "create_table" ? "No object" : opTitle(op)}</div><div className={cn("min-h-24 border-l-2 p-5", op.risk === "SAFE" ? "border-l-emerald-400/60" : op.risk === "LOCKING" ? "border-l-amber-400/60" : "border-l-rose-400/60")}><div className="flex items-center justify-between"><div className="text-sm font-medium"><span className="mr-3 font-mono text-accent">+</span>{opTitle(op)}</div><RiskBadge risk={op.risk} /></div><div className="ml-6 mt-3 font-mono text-xs text-muted">{opDetail(op)}</div>{(op.kind === "add_constraint" || op.kind === "add_index") && <Badge className="ml-6 mt-3 border-violet-400/25 bg-violet-400/10 text-violet-300">declared — enforced on merge</Badge>}</div></div>;
}

function DataBrowser({ branch, schema }: { branch: string; schema: SchemaIR | null }) {
  const [table, setTable] = useState(schema?.tables[0]?.name ?? "");
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; rowCount: number } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setTable(schema?.tables[0]?.name ?? ""); setResult(null); }, [branch, schema]);
  useEffect(() => {
    if (!table) return;
    setLoading(true); setError("");
    void api.rows(branch, table).then(setResult).catch((cause) => setError(messageOf(cause))).finally(() => setLoading(false));
  }, [branch, table]);
  const selectedTable = schema?.tables.find((item) => item.name === table);
  const schemaColumns = [...(selectedTable?.columns ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const columns = schemaColumns.length ? schemaColumns.map((column) => column.name) : result?.rows[0] ? Object.keys(result.rows[0]) : [];
  if (!schema?.tables.length) return <StatePanel kind="empty" title="No tables on this branch">Create a table with DDL, then return here to query it through the branch schema.</StatePanel>;
  return (
    <div className="grid grid-cols-[260px_1fr] gap-4">
      <Card className="h-fit p-3">
        <div className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Tables</div>
        {schema.tables.map((item) => (
          <button
            key={item.name}
            onClick={() => setTable(item.name)}
            className={cn("w-full rounded-md px-3 py-2.5 text-left hover:bg-white/5", table === item.name && "bg-white/5")}
          >
            <div className={cn("flex items-center gap-2 font-mono text-xs text-muted", table === item.name && "text-foreground")}>
              <Table2 className="h-3.5 w-3.5 shrink-0" />
              {item.name}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1 pl-6">
              {item.constraints.length === 0 ? (
                <span className="text-[10px] text-muted/55">no constraints</span>
              ) : item.constraints.map((constraint) => (
                <span
                  key={constraint.name}
                  className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", constraintKindClasses[constraint.kind])}
                >
                  {constraintKindShort(constraint.kind)}
                  {constraint.columns[0] ? ` ${constraint.columns[0]}` : ""}
                </span>
              ))}
            </div>
          </button>
        ))}
      </Card>
      <div className="min-w-0 space-y-4">
        <TableSchemaCard table={selectedTable} declared={branch !== "main"} />
        <Card className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <div className="font-mono text-sm">{branch}.{table}</div>
              <div className="mt-1 text-xs text-muted">{result ? `${result.rowCount.toLocaleString()} real rows · showing ${result.rows.length}` : "Querying through branch view"}</div>
            </div>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-accent" />}
          </div>
          {error ? (
            <div className="p-5 text-sm text-red-300">{error}</div>
          ) : (
            <div className="max-h-[620px] overflow-auto scrollbar-thin">
              <table className="w-full border-collapse text-left font-mono text-xs">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    {(schemaColumns.length ? schemaColumns : columns.map((name) => ({ name, type: "", nullable: true }))).map((column) => (
                      <th key={column.name} className="border-b border-r border-border px-4 py-3 font-medium text-muted">
                        <div>{column.name}</div>
                        {column.type && (
                          <div className="mt-1 text-[10px] font-normal text-muted/65">
                            {shortType(column.type)}{column.nullable ? "" : " · not null"}
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result?.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-white/[.025]">
                      {columns.map((column) => (
                        <td key={column} className="max-w-72 truncate border-b border-r border-border/70 px-4 py-3">
                          {row[column] == null ? <span className="text-muted/50">NULL</span> : String(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function TableSchemaCard({ table, declared }: { table: Table | undefined; declared: boolean }) {
  if (!table) return null;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <div className="text-sm font-semibold">Constraints on {table.name}</div>
          <p className="mt-1 text-xs text-muted">
            {table.constraints.length} constraint{table.constraints.length === 1 ? "" : "s"}
            {table.indexes.length ? ` · ${table.indexes.length} index${table.indexes.length === 1 ? "" : "es"}` : ""}
          </p>
        </div>
        {declared && <Badge className="border-violet-400/25 bg-violet-400/10 text-violet-300">declared — enforced on merge</Badge>}
      </div>
      {table.constraints.length === 0 ? (
        <p className="px-5 py-4 text-xs text-muted">No constraints on this table.</p>
      ) : (
        <div className="divide-y divide-border">
          {table.constraints.map((constraint) => (
            <div key={constraint.name} className="flex items-start gap-4 px-5 py-3.5">
              <div className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border", constraintKindClasses[constraint.kind])}>
                <ConstraintKindIcon kind={constraint.kind} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={constraintKindClasses[constraint.kind]}>{constraintKindLabel(constraint.kind)}</Badge>
                  <span className="font-mono text-xs">{constraint.name}</span>
                </div>
                {constraintDetail(constraint) && (
                  <div className="mt-1.5 font-mono text-[11px] text-muted">{constraintDetail(constraint)}</div>
                )}
              </div>
              <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide", constraint.validated ? "text-emerald-300" : "text-amber-300")}>
                {constraint.validated ? "validated" : "not valid"}
              </span>
            </div>
          ))}
        </div>
      )}
      {table.indexes.length > 0 && (
        <div className="border-t border-border">
          <div className="px-5 py-2 text-[10px] font-semibold uppercase tracking-[.14em] text-muted">Indexes</div>
          <div className="divide-y divide-border">
            {table.indexes.map((index) => <IndexRow key={index.name} index={index} />)}
          </div>
        </div>
      )}
    </Card>
  );
}

function ConstraintKindIcon({ kind }: { kind: Constraint["kind"] }) {
  const className = "h-3.5 w-3.5";
  if (kind === "primary") return <Key className={className} />;
  if (kind === "unique") return <Hash className={className} />;
  if (kind === "check") return <ShieldCheck className={className} />;
  return <Link2 className={className} />;
}

function IndexRow({ index }: { index: Index }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-2.5 font-mono text-xs">
      <span>{index.name}</span>
      <span className="text-muted">{index.method} ({index.columns.join(", ")})</span>
      {index.unique && <Badge className="border-violet-400/25 bg-violet-400/10 text-violet-300">unique</Badge>}
      {index.predicate && <span className="text-muted">WHERE {index.predicate}</span>}
    </div>
  );
}

function Editor({
  branch,
  creating,
  onCreate,
  onChanged,
  onReview,
}: {
  branch: string;
  creating: boolean;
  onCreate: (name: string) => Promise<void>;
  onChanged: (name?: string) => Promise<void>;
  onReview: () => void;
}) {
  const onMain = branch === "main";
  const [sql, setSql] = useState(EXAMPLE_DDL);
  const [newBranch, setNewBranch] = useState("accounts-retype");
  const [message, setMessage] = useState("Retype accounts.name to varchar(200)");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = busy || creating;
  const apply = async () => {
    setBusy(true); setError("");
    try {
      const target = onMain ? newBranch.trim().toLowerCase() : branch;
      if (onMain) {
        if (!target) throw new Error("Name a branch before applying DDL. Main is the merge target.");
        await onCreate(target);
      }
      const result = await api.ddl(target, sql);
      await onChanged(target);
      setStatus(`${result.ops.length} catalog operation${result.ops.length === 1 ? "" : "s"} applied to working tree`);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (onMain) return;
    setBusy(true); setError("");
    try { await api.commit(branch, message); await onChanged(branch); setStatus("Committed. Branch is ready for merge preview."); }
    catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="grid grid-cols-[1fr_330px] gap-5">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="font-mono text-xs text-muted">branch://{onMain ? (newBranch.trim() || "new-branch") : branch}/schema.sql</div>
          <Badge>PostgreSQL DDL only</Badge>
        </div>
        <div className="relative">
          <div className="absolute bottom-0 left-0 top-0 w-12 select-none border-r border-border bg-black/15 pt-5 text-right font-mono text-xs leading-6 text-muted/50">{sql.split("\n").map((_, index) => <div key={index} className="pr-3">{index + 1}</div>)}</div>
          <textarea spellCheck={false} value={sql} onChange={(event) => setSql(event.target.value)} className="h-[520px] w-full resize-none bg-transparent py-5 pl-16 pr-5 font-mono text-[13px] leading-6 text-[#d3d7dc] outline-none" />
        </div>
        <div className="flex items-center justify-between border-t border-border px-5 py-4">
          <div className="text-xs text-muted">{onMain ? "Creates a branch, then applies there — main stays untouched" : "Parsed by PostgreSQL · DML rejected"}</div>
          <Button disabled={locked || !sql.trim() || (onMain && !newBranch.trim())} onClick={() => void apply()}>
            {locked ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {onMain ? "Create branch and apply" : "Apply to branch"}
          </Button>
        </div>
      </Card>
      <div className="space-y-4">
        {onMain && (
          <Card className="p-5">
            <div className="text-sm font-semibold">Branch from main</div>
            <p className="mt-2 text-xs leading-5 text-muted">Main cannot take DDL directly. Name the change branch this SQL will apply to.</p>
            <input value={newBranch} onChange={(event) => setNewBranch(event.target.value.toLowerCase())} placeholder="accounts-retype" className="mt-4 h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm outline-none focus:border-accent/50" />
          </Card>
        )}
        <Card className="p-5">
          <div className="text-sm font-semibold">Working tree → commit</div>
          <p className="mt-2 text-xs leading-5 text-muted">DDL updates branch views immediately. Merge preview accepts committed state only.</p>
          <input value={message} onChange={(event) => setMessage(event.target.value)} className="mt-4 h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-accent/50" />
          <Button variant="outline" className="mt-3 w-full" disabled={onMain || locked || !message.trim()} onClick={() => void commit()}><Check className="h-4 w-4" />Commit schema state</Button>
          <Button variant="ghost" className="mt-2 w-full" disabled={onMain} onClick={onReview}>Open merge review <ArrowRight className="h-4 w-4" /></Button>
        </Card>
        <Card className="p-5"><Badge className="border-violet-400/25 bg-violet-400/10 text-violet-300">declared — enforced on merge</Badge><p className="mt-3 text-xs leading-5 text-muted">Constraints and indexes are recorded as desired schema state. They are validated and created against real data during merge.</p></Card>
        {status && <div className="rounded-lg border border-accent/20 bg-accent/[.05] p-4 text-xs text-accent">{status}</div>}
        {error && <div className="rounded-lg border border-red-400/20 bg-red-400/[.05] p-4 text-xs text-red-300">{error}</div>}
      </div>
    </div>
  );
}

function LiveMerge({ merge, telemetry, onRefresh, onRevert, onContract }: { merge: MergeDetail | null; telemetry: Telemetry[]; onRefresh: () => void; onRevert: () => Promise<void>; onContract: () => Promise<void> }) {
  const latest = [...telemetry].reverse().find((event) => event.type === "backfill_progress") ?? {};
  const rowsDone = Number(latest.rowsDone ?? 0);
  const rowsTotal = Number(latest.rowsTotal ?? merge?.steps.find((step) => step.rows_total)?.rows_total ?? 0);
  const percent = rowsTotal > 0 ? Math.min(100, rowsDone / rowsTotal * 100) : merge?.state === "merged" ? 100 : 0;
  if (!merge) return <StatePanel kind="empty" title="No migration selected">Apply a reviewed merge plan to open live telemetry.</StatePanel>;
  const failed = merge.state === "failed" || merge.steps?.some((step) => step.state === "failed");
  if (failed) return <StatePanel kind="failure" title="Migration paused safely" action={<Button variant="outline" onClick={onRefresh}><RefreshCw className="h-4 w-4" />Refresh state</Button>}>{merge.error ?? "A step failed. Completed steps are persisted; applying again resumes from the first incomplete step."}</StatePanel>;
  const running = ["planned", "running"].includes(merge.state);
  return (
    <div className="space-y-5">
      <Card className="p-6"><div className="flex items-start justify-between"><div className="flex gap-4">{running ? <div className="grid h-11 w-11 place-items-center rounded-full bg-accent/10"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div> : <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-400/10"><Check className="h-5 w-5 text-emerald-300" /></div>}<div><div className="text-lg font-semibold">{running ? "Migration in progress" : `Merge ${merge.state}`}</div><div className="mt-1 font-mono text-xs text-muted">merge #{merge.id} · branch → main</div></div></div><Badge className={running ? "border-accent/25 bg-accent/10 text-accent" : "border-emerald-400/25 bg-emerald-400/10 text-emerald-300"}>{merge.state}</Badge></div><div className="mt-7 h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${percent}%` }} /></div><div className="mt-3 flex justify-between font-mono text-xs text-muted"><span>{percent.toFixed(1)}%</span><span>{rowsTotal ? `${rowsDone.toLocaleString()} / ${rowsTotal.toLocaleString()} rows` : "catalog steps"}</span></div></Card>
      <div className="grid grid-cols-4 gap-4"><MetricCard value={`${Number(latest.rowsPerSec ?? 0).toLocaleString()}`} label="rows / second" /><MetricCard value={`${merge.steps?.reduce((sum, step) => sum + Number(step.lock_attempts ?? 0), 0) ?? 0}`} label="lock attempts" /><MetricCard value={bytes(Number(latest.bloatBytes ?? 0))} label="live bloat" /><MetricCard value={latest.etaSec ? `${Math.ceil(Number(latest.etaSec))}s` : "—"} label="ETA" /></div>
      <div className="grid grid-cols-[1fr_390px] gap-5"><Card className="overflow-hidden"><div className="border-b border-border px-5 py-4 text-sm font-semibold">Execution steps</div><div className="divide-y divide-border">{merge.steps?.map((step) => <div key={step.seq} className="grid grid-cols-[28px_100px_1fr_90px] items-center gap-3 px-5 py-3 text-xs"><span className={cn("h-2 w-2 rounded-full bg-muted/40", step.state === "done" && "bg-accent", step.state === "running" && "animate-pulse bg-amber-300", step.state === "failed" && "bg-red-400")} /><span className="font-semibold uppercase">{step.kind}</span><span className="truncate font-mono text-muted">{step.error ?? step.sql}</span><span className="text-right font-mono text-muted">{step.state}</span></div>)}</div></Card><Card className="overflow-hidden"><div className="border-b border-border px-5 py-4 text-sm font-semibold">Event stream</div><div className="h-72 space-y-2 overflow-auto p-4 font-mono text-[11px] scrollbar-thin">{telemetry.length ? telemetry.slice(-50).map((event, index) => <div key={index} className="rounded bg-black/25 p-2 text-muted"><span className="mr-2 text-accent">›</span>{String(event.type ?? "event")} {event.type === "lock_retry" ? `attempt ${Number(event.attempt) + 1}` : event.type === "backfill_progress" ? `${Number(event.rowsPerSec ?? 0).toLocaleString()} rows/s` : ""}</div>) : <div className="text-muted">Waiting for migration events…</div>}</div></Card></div>
      {merge.state === "merged" && !merge.contracted_at && <div className="flex items-center justify-between rounded-xl border border-red-400/30 bg-red-400/[.055] p-5"><div><div className="font-semibold text-red-200">Destructive zone</div><div className="mt-1 text-xs text-muted">Revert is lossless until contract permanently drops retained data.</div></div><div className="flex gap-3"><Button variant="outline" onClick={() => void onRevert()}>Revert merge</Button><Button variant="destructive" onClick={() => { if (confirm("Contract permanently drops retained columns. This cannot be undone. Continue?")) void onContract(); }}><Trash2 className="h-4 w-4" />Contract — permanently drop</Button></div></div>}
    </div>
  );
}

function FailureBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="mb-5 flex items-center gap-3 rounded-lg border border-red-400/25 bg-red-400/[.06] px-4 py-3 text-sm text-red-200"><XCircle className="h-4 w-4 shrink-0" /><span className="flex-1">{message}</span><button onClick={onClose} className="text-red-200/60 hover:text-red-200">×</button></div>;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div><div className="font-mono text-xl font-medium">{value}</div><div className="mt-1 text-[11px] text-muted">{label}</div></div>;
}

function MetricCard({ value, label }: { value: string; label: string }) {
  return <Card className="p-5"><div className="font-mono text-xl">{value}</div><div className="mt-1 text-xs text-muted">{label}</div></Card>;
}

function messageOf(cause: unknown): string {
  if (cause instanceof ApiError && cause.body.state === "dirty") return "A branch has uncommitted DDL. Commit both working trees before merging or integrating.";
  return cause instanceof Error ? cause.message : "Unexpected failure";
}
