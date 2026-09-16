import type { Column, SchemaIR } from "../ir/types.js";
import { findColumn, findTable } from "../ir/types.js";
import { canonicalizeTypeString } from "../ir/typecanon.js";
import { diff, type SchemaOp } from "./diff.js";

export type RenameSuggestion = {
  table: string;
  from: string;
  to: string;
  reason: string;
};

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Uint16Array(n + 1);
  const cur = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev.set(cur);
  }
  return prev[n] ?? 0;
}

export function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function similar(from: string, to: string): { ok: true; reason: string } | { ok: false } {
  const d = levenshtein(from, to);
  if (d <= 3) return { ok: true, reason: `Levenshtein ${d}` };
  const p = sharedPrefixLen(from, to);
  if (p >= 4) return { ok: true, reason: `shared prefix '${from.slice(0, p)}'` };
  return { ok: false };
}

function compatible(fromCol: Column, toCol: Column): boolean {
  return (
    canonicalizeTypeString(fromCol.type) === canonicalizeTypeString(toCol.type) &&
    fromCol.nullable === toCol.nullable
  );
}

/**
 * Suggest drop+add pairs that are likely renames. Never mutates `ops`.
 * A wrong automatic rename is a data-loss bug; the UI must confirm these.
 */
export function detectRenames(from: SchemaIR, ops: SchemaOp[]): RenameSuggestion[] {
  const drops = new Map<string, string[]>();
  const adds = new Map<string, Column[]>();

  for (const op of ops) {
    if (op.kind === "drop_column") {
      const list = drops.get(op.table) ?? [];
      list.push(op.column);
      drops.set(op.table, list);
    } else if (op.kind === "add_column") {
      const list = adds.get(op.table) ?? [];
      list.push(op.column);
      adds.set(op.table, list);
    }
  }

  const suggestions: RenameSuggestion[] = [];
  const usedTo = new Set<string>();
  const usedFrom = new Set<string>();

  for (const [table, dropped] of drops) {
    const added = adds.get(table) ?? [];
    const tbl = findTable(from, table);
    if (!tbl) continue;

    const candidates: (RenameSuggestion & { score: number })[] = [];
    for (const name of dropped) {
      const fromCol = findColumn(tbl, name);
      if (!fromCol) continue;
      for (const toCol of added) {
        if (!compatible(fromCol, toCol)) continue;
        const sim = similar(name, toCol.name);
        if (!sim.ok) continue;
        const d = levenshtein(name, toCol.name);
        candidates.push({
          table,
          from: name,
          to: toCol.name,
          reason: sim.reason,
          score: d,
        });
      }
    }

    candidates.sort((a, b) => a.score - b.score || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    for (const c of candidates) {
      const fk = `${c.table}.${c.from}`;
      const tk = `${c.table}.${c.to}`;
      if (usedFrom.has(fk) || usedTo.has(tk)) continue;
      usedFrom.add(fk);
      usedTo.add(tk);
      suggestions.push({ table: c.table, from: c.from, to: c.to, reason: c.reason });
    }
  }

  suggestions.sort((a, b) => a.table.localeCompare(b.table) || a.from.localeCompare(b.from));
  return suggestions;
}

export function diffWithSuggestions(from: SchemaIR, to: SchemaIR): {
  ops: SchemaOp[];
  renameSuggestions: RenameSuggestion[];
} {
  const ops = diff(from, to);
  return { ops, renameSuggestions: detectRenames(from, ops) };
}
