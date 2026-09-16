import type { SchemaOp } from "@gitdb/api/diff/diff";
import type { SchemaIR } from "@gitdb/api/ir/types";

export type Risk = "SAFE" | "LOCKING" | "REWRITE";
export type Branch = {
  name: string;
  schema_name: string;
  head_commit: string | null;
  base_commit: string | null;
  stale_reason: string | null;
  created_at: string;
};
export type RiskOp = SchemaOp & { risk: Risk };
export type DiffResponse = {
  ops: RiskOp[];
  renameSuggestions: Array<{ table: string; from: string; to: string; score?: number }>;
};
export type MigrationStep = {
  seq: number;
  kind: string;
  sql: string;
  risk: Risk;
  manual?: boolean;
  table?: string;
  column?: string;
};
export type MergePreview = {
  id: number;
  state: string;
  ops: SchemaOp[];
  plan: MigrationStep[];
  resultIR: SchemaIR;
};
export type ValidateReport = {
  branch: string;
  findings: Array<{
    op: SchemaOp;
    blocked: boolean;
    message: string;
    count?: number;
    samples?: Record<string, unknown>[];
  }>;
  blocked: boolean;
};
export type MergeDetail = MergePreview & {
  error?: string | null;
  contracted_at?: string | null;
  steps: Array<MigrationStep & {
    state: string;
    rows_done: string | number;
    rows_total: string | number | null;
    lock_attempts: number;
    ms: number | null;
    error?: string | null;
  }>;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const record = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(String(record.message ?? record.state ?? "Request failed"), response.status, record);
  }
  return body as T;
}

export const api = {
  branches: () => request<Branch[]>("/api/branches"),
  schema: (branch: string) =>
    request<{ ir: SchemaIR; hash: string }>(`/api/branches/${encodeURIComponent(branch)}/schema`),
  stats: (branch: string) =>
    request<{ rowCount: number; sizeBytes: number; exact: boolean }>(
      `/api/branches/${encodeURIComponent(branch)}/stats`,
    ),
  createBranch: (name: string) =>
    request<Branch>("/api/branches", { method: "POST", body: JSON.stringify({ name, from: "main" }) }),
  rows: (branch: string, table: string, limit = 25) =>
    request<{ rows: Record<string, unknown>[]; rowCount: number; limit: number }>(
      `/api/branches/${encodeURIComponent(branch)}/tables/${encodeURIComponent(table)}/rows?limit=${limit}`,
    ),
  ddl: (branch: string, sql: string) =>
    request<{ ir: SchemaIR; hash: string; ops: SchemaOp[] }>(
      `/api/branches/${encodeURIComponent(branch)}/ddl`,
      { method: "POST", body: JSON.stringify({ sql }) },
    ),
  commit: (branch: string, message: string) =>
    request<{ id: string }>(`/api/branches/${encodeURIComponent(branch)}/commit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  diff: (branch: string) =>
    request<DiffResponse>(`/api/diff?from=main&to=${encodeURIComponent(branch)}`),
  previewMerge: (branch: string) =>
    request<MergePreview>("/api/merges", {
      method: "POST",
      body: JSON.stringify({ source: branch, target: "main" }),
    }),
  merge: (id: number) => request<MergeDetail>(`/api/merges/${id}`),
  applyMerge: (id: number) =>
    request<MergeDetail>(`/api/merges/${id}/apply`, { method: "POST" }),
  revertMerge: (id: number) =>
    request<MergeDetail>(`/api/merges/${id}/revert`, { method: "POST" }),
  contractMerge: (id: number) =>
    request<MergeDetail>(`/api/merges/${id}/contract`, { method: "POST" }),
  validate: (branch: string) =>
    request<ValidateReport>("/api/validate", {
      method: "POST",
      body: JSON.stringify({ branch }),
    }),
  resetDemo: () =>
    request<{ state: string; commit: string }>("/api/demo/reset", { method: "POST" }),
  deleteBranch: (name: string) =>
    request<void>(`/api/branches/${encodeURIComponent(name)}`, { method: "DELETE" }),
};

export type { SchemaIR, SchemaOp };
