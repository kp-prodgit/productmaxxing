// Bridge 2 of joining PMX and PMX Engine (EQ-34): customer evidence reaches the head of product's studio as counts.
// For each roadmap theme a PM labelled tasks with (EQ-38), and each task category among the tasks with no theme, how
// many approved tasks there are, how many sources they cite, and the first and last day one was made. No titles,
// descriptions, quotes, source IDs or meeting details: only these fields, which PMX Engine checks one by one. PMX writes
// it to standard output and nowhere else; the head of product pipes it into `pmxe propose -` and maps each category
// row to a roadmap theme while accepting it.
import type { Task } from "../core/types.js";

/**
 * Format 2 (OUT-6): every task is in exactly one row, so the rows never overlap and PMX Engine can add them up. A
 * themed task counts in its theme's row only; category rows count the tasks with no theme. Format 1, what PMX 0.37
 * and earlier printed, counted every task in its category as well, themed ones again. PMX Engine 0.14 and earlier
 * accept only format 1 (any other number, and any field they don't know, is refused), so `--format 1` still prints it.
 */
export const EVIDENCE_FORMAT = 2;
export type EvidenceFormat = 1 | 2;

export interface EvidenceRow { by: "category" | "theme"; label: string; tasks: number; sources: number; first: string; last: string }
export interface Evidence { format: EvidenceFormat; kind: "pmx-evidence"; team: string; at: string; rows: EvidenceRow[] }

const day = (iso: string) => (iso || "").slice(0, 10);

/**
 * The counts. A task counts once: in its theme when it has one, else in its category (format 1: in its category
 * and in its theme). Its sources are the ones it cites, so a source two tasks cite counts for each: PMX's source IDs
 * are per run, so the same meeting can't be told apart across runs from the tracker alone.
 */
export function evidenceOf(tasks: Task[], team: string, now: Date, format: EvidenceFormat = EVIDENCE_FORMAT): Evidence {
  const groups = new Map<string, { by: EvidenceRow["by"]; label: string; list: Task[] }>();
  const add = (by: EvidenceRow["by"], label: string | null | undefined, t: Task) => {
    if (!label) return;
    const key = `${by}\u0000${label}`;
    (groups.get(key) ?? groups.set(key, { by, label, list: [] }).get(key)!).list.push(t);
  };
  for (const t of tasks) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(t.createdAt ?? "")) continue;
    if (format === 1 || !t.theme) add("category", t.category, t);
    add("theme", t.theme ?? null, t);
  }
  const rows = [...groups.values()].map((g): EvidenceRow => {
    const days = g.list.map((t) => day(t.createdAt)).sort();
    return { by: g.by, label: g.label.slice(0, 60), tasks: g.list.length, sources: g.list.reduce((n, t) => n + t.sources.length, 0), first: days[0]!, last: days[days.length - 1]! };
  });
  rows.sort((a, b) => (a.by === b.by ? b.tasks - a.tasks || a.label.localeCompare(b.label) : a.by === "theme" ? -1 : 1));
  return { format, kind: "pmx-evidence", team, at: now.toISOString(), rows: rows.slice(0, 100) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `pmx evidence` in Terminal: the same rows as `--json`, in words, with how many tasks they hold in all. */
export function formatEvidence(e: Evidence): string {
  if (!e.rows.length) return "No approved tasks yet.";
  const kind = e.format === 1 ? "kind of work" : "kind of work, no theme";
  const lines = e.rows.map((r) => `${r.by === "theme" ? "theme" : kind}  ${r.label}: ${plural(r.tasks, "task")}, ${plural(r.sources, "source")}, ${r.first} to ${r.last}`);
  const sum = (by: EvidenceRow["by"]) => e.rows.filter((r) => r.by === by).reduce((n, r) => n + r.tasks, 0);
  lines.push("", e.format === 1
    ? "Format 1: each task counts in its kind of work, and in its theme too when it has one."
    : `${plural(sum("theme") + sum("category"), "approved task")}, each counted once: ${sum("theme")} under a roadmap theme, ${sum("category")} by kind of work.`);
  lines.push("To bring these into PMX Engine's studio, where you map each kind of work to a roadmap theme: pmx evidence --json | pmxe propose -");
  if (e.format !== 1) lines.push("PMX Engine 0.14 or earlier takes only the older counts: pmx evidence --json --format 1 | pmxe propose -");
  return lines.join("\n");
}
