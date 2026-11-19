// Bridge 2 of joining PMX and PMX Engine (EQ-34): customer evidence reaches the head of product's studio as counts.
// For each task category, and each roadmap theme a PM labelled tasks with (EQ-38), how many approved tasks there are,
// how many sources they cite, and the first and last day one was made. No titles, descriptions, quotes, source IDs or
// meeting details: only these fields, which PMX Engine checks one by one. PMX writes it to standard output and nowhere
// else; the head of product pipes it into `pmxe propose -` and maps each count to a roadmap theme while accepting it.
import type { Task } from "../core/types.js";

export const EVIDENCE_FORMAT = 1;

export interface EvidenceRow { by: "category" | "theme"; label: string; tasks: number; sources: number; first: string; last: string }
export interface Evidence { format: number; kind: "pmx-evidence"; team: string; at: string; rows: EvidenceRow[] }

const day = (iso: string) => (iso || "").slice(0, 10);

/**
 * The counts. A task counts once in its category and once in its theme. Its sources are the ones it cites, so a
 * source two tasks cite counts for each: PMX's source IDs are per run, so the same meeting can't be told apart
 * across runs from the tracker alone.
 */
export function evidenceOf(tasks: Task[], team: string, now: Date): Evidence {
  const groups = new Map<string, { by: EvidenceRow["by"]; label: string; list: Task[] }>();
  const add = (by: EvidenceRow["by"], label: string | null | undefined, t: Task) => {
    if (!label) return;
    const key = `${by}\u0000${label}`;
    (groups.get(key) ?? groups.set(key, { by, label, list: [] }).get(key)!).list.push(t);
  };
  for (const t of tasks) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(t.createdAt ?? "")) continue;
    add("category", t.category, t);
    add("theme", t.theme ?? null, t);
  }
  const rows = [...groups.values()].map((g): EvidenceRow => {
    const days = g.list.map((t) => day(t.createdAt)).sort();
    return { by: g.by, label: g.label.slice(0, 60), tasks: g.list.length, sources: g.list.reduce((n, t) => n + t.sources.length, 0), first: days[0]!, last: days[days.length - 1]! };
  });
  rows.sort((a, b) => (a.by === b.by ? b.tasks - a.tasks || a.label.localeCompare(b.label) : a.by === "theme" ? -1 : 1));
  return { format: EVIDENCE_FORMAT, kind: "pmx-evidence", team, at: now.toISOString(), rows: rows.slice(0, 100) };
}
