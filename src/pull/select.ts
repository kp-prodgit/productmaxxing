import { budgetBlock, type Budget } from "../budget/provider.js";
import { takesCategory, type PersonalConfig, type TeamConfig } from "../core/config.js";
import type { Task } from "../core/types.js";

export interface Decision {
  task: Task;
  ok: boolean;
  why: string;
}

export interface Selection {
  /** Reasons nothing can be pulled right now, before looking at tasks. */
  blockers: string[];
  /** Every ready task, in pull order, with the reason it was or wasn't chosen. */
  decisions: Decision[];
  /** Candidates that passed every check, best first. The first one that wins its lease runs. */
  candidates: Task[];
}

export interface SelectInput {
  tasks: Task[];
  agent: string;
  personal: PersonalConfig;
  team: TeamConfig;
  budget: Budget;
  now: Date;
  /** Drafts from this agent waiting for review (PULL-4). */
  inReview: number;
  /** Categories auto-paused for a low accept rate (REV-3) or blocked by admin policy. */
  pausedCategories: Map<string, string>;
  leasedTaskIds: Set<string>;
  /** Failed runs in a row per task, by Linear identifier (PULL-11). A task that just failed runs after the others. */
  failStreaks?: Map<string, number>;
  /** Tasks this Mac can't run, by task ID, and why: their evidence is elsewhere (RUN-3). */
  unrunnable?: Map<string, string>;
}

/** Linear priority: 1 urgent … 4 low, 0 none (sorted last). */
const prio = (t: Task) => (t.priority === 0 ? 5 : t.priority);

/**
 * The pull policy (PULL-1..4, PULL-8). Pure, so `--dry-run` explains exactly what a real pull would do.
 */
export function selectTasks(i: SelectInput): Selection {
  const blockers: string[] = [];
  const cap = i.team.reviewQueueCap;
  if (i.inReview >= cap) blockers.push(`${i.inReview} of your drafts are waiting for review (cap ${cap}); review some first`);
  const paused = budgetBlock(i.budget);
  if (paused) blockers.push(paused);

  const failed = (t: Task) => i.failStreaks?.get(t.identifier) ?? 0;
  const ready = i.tasks
    .filter((t) => t.status === "ready")
    .sort((a, b) => Math.sign(failed(a)) - Math.sign(failed(b)) || prio(a) - prio(b) || a.createdAt.localeCompare(b.createdAt));

  const decisions: Decision[] = ready.map((t) => {
    const no = (why: string): Decision => ({ task: t, ok: false, why });
    if (!t.category || !i.team.categories[t.category]) return no(`category "${t.category ?? "none"}" has no skill in team config`);
    if (!takesCategory(i.personal, i.team, t.category)) return no(`you don't accept ${t.category}`);
    const paused = i.pausedCategories.get(t.category);
    if (paused) return no(`${t.category} is paused: ${paused}`);
    if (!t.size) return no("no size label");
    const elsewhere = i.unrunnable?.get(t.id);
    if (elsewhere) return no(elsewhere);
    if (i.leasedTaskIds.has(t.id)) return no("already claimed by another agent");
    const est = i.team.sizes[t.size];
    if (est.costUsd > i.budget.remainingUsd) return no(`size ${t.size} needs ~$${est.costUsd.toFixed(2)}, $${i.budget.remainingUsd.toFixed(2)} left`);
    if ((t.size === "L" || t.size === "XL") && i.budget.minutesToReset < est.minutes)
      return no(`size ${t.size} takes ~${est.minutes} min, only ${i.budget.minutesToReset} min until the budget resets`);
    const f = failed(t);
    return { task: t, ok: true, why: `fits: ${t.size} ~$${est.costUsd.toFixed(2)}, priority ${t.priority || "none"}${f ? `; its last ${f === 1 ? "run" : `${f} runs`} failed, so it goes after the others` : ""}` };
  });

  return { blockers, decisions, candidates: blockers.length ? [] : decisions.filter((d) => d.ok).map((d) => d.task) };
}

export function explain(s: Selection, dryRun: boolean): string {
  const lines: string[] = [];
  if (s.blockers.length) lines.push(`Nothing will be pulled: ${s.blockers.join("; ")}.`);
  if (!s.decisions.length) lines.push("No ready tasks in the PMX project.");
  for (const d of s.decisions) lines.push(`${d.ok ? "✔" : "·"} ${d.task.identifier} ${d.task.title} — ${d.why}`);
  const next = s.candidates[0];
  if (next) lines.push("", `${dryRun ? "Would pull" : "Pulling"}: ${next.identifier} ${next.title}`);
  return lines.join("\n");
}
