import type { Asker } from "../core/ask.js";
import type { Ctx } from "../core/context.js";
import type { Services } from "../core/services.js";
import type { FollowUpResult } from "./followups.js";
import { loadQueue, recordDecision, type ReviewItem, type Verdict } from "./queue.js";

function summary(item: ReviewItem): string {
  const r = item.record;
  const lines = [
    `━━ ${item.task.identifier} · ${item.task.title}`,
    `   ${item.task.category} · size ${item.task.size} · ${item.prUrl}`,
  ];
  if (r) {
    lines.push(`   ${r.skill.name}@${r.skill.version} · ${r.model} · ${r.agent} · ${(r.durationMs / 60000).toFixed(1)} min${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ""}`);
    lines.push(`   clean profile ${r.profile.checksFailed.length ? "✘ " + r.profile.checksFailed.join(", ") : "✔"} · checklist ${r.checklist.ok ? "✔" : "⚠ " + r.checklist.problems.join("; ")}`);
    // RUN-6: a reviewer should know the draft drew on the web as well as the team's sources.
    if (r.web) lines.push(`   used the web (WebSearch, WebFetch): each claim from a page cites its URL and the date it was read${r.webBlocked ? `; PMX's web guard blocked ${r.webBlocked} ${r.webBlocked === 1 ? "call" : "calls"} that carried the task's evidence` : ""}`);
  } else lines.push("   ⚠ no run record");
  return lines.join("\n");
}

/** Where the terminal finds what an accept made (FOLLOW-1). Only the CLI says it: the pages never show a command. */
export function followUpHint(made: (FollowUpResult | null)[]): string | null {
  const todos = made.some((f) => f?.todos.length), tasks = made.some((f) => f?.proposals.length);
  if (!todos && !tasks) return null;
  return [todos ? "Your to-dos: pmx todo" : "", tasks ? "Tasks waiting for your approval: pmx proposals" : ""].filter(Boolean).join(" · ");
}

/** F21: without a terminal, every prompt would take its default and nothing would be decided. */
export const NO_TERMINAL = "No terminal here: use --accept, --redo or --reject with a task id.";

/** `pmx review`: the terminal review queue (REV-2). */
export async function terminalReview(ctx: Ctx, svc: Services, ask: Asker, o: { all?: boolean } = {}): Promise<string> {
  const { items, host } = await loadQueue(ctx, svc, o);
  if (!items.length) return "Nothing waiting for review.";
  const done: string[] = [];
  const made: (FollowUpResult | null)[] = [];
  for (const item of items) {
    ctx.out.info("\n" + summary(item));
    for (const f of item.files) ctx.out.info(`\n── ${f.path}\n\n${f.content.trim()}\n`);
    const shownAt = Date.now();
    const choice = await ask.choose("Decision", ["accept", "redo", "reject", "skip", "quit"], "skip");
    if (choice === "quit") break;
    if (choice === "skip") continue;
    const verdict: Verdict = choice === "accept" ? "accepted" : choice === "reject" ? "rejected" : "redo";
    const note = verdict === "accepted" ? undefined : await ask.text(verdict === "redo" ? "What should the agent change?" : "Why reject it?");
    const d = await recordDecision(ctx, svc, host, item, verdict, { note, reviewMinutes: Math.max(1, Math.round((Date.now() - shownAt) / 60000)) });
    done.push(d.message);
    made.push(d.followUps);
  }
  const hint = followUpHint(made);
  return done.length ? [...done, ...(hint ? [hint] : [])].join("\n") : "No decisions made.";
}

export interface ScriptedReview {
  /** Task identifiers to accept, as typed: `--accept PMX-12 PMX-13` or `--accept PMX-12,PMX-13`. */
  accept?: string[];
  redo?: string;
  reject?: string;
  /** The note a redo or reject needs, as the terminal review asks for one. */
  note?: string;
}

/**
 * F21: `pmx review --accept <id…>`, `--redo <id> --note "…"` and `--reject <id> --note "…"`, for a script, a
 * scheduled task or a Claude session with no terminal. Each records exactly what the terminal review records: the
 * same decision, run log entry, tracker comment and status, and an accept's follow-ups. Every task named must be waiting
 * for review here; otherwise nothing is decided and the answer says which wasn't.
 */
export async function scriptedReview(ctx: Ctx, svc: Services, o: ScriptedReview): Promise<{ text: string; code: number }> {
  const ids = (xs: string[]) => xs.flatMap((x) => x.split(/[,\s]+/)).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const picks: { id: string; verdict: Verdict }[] = [
    ...ids(o.accept ?? []).map((id) => ({ id, verdict: "accepted" as const })),
    ...ids(o.redo ? [o.redo] : []).map((id) => ({ id, verdict: "redo" as const })),
    ...ids(o.reject ? [o.reject] : []).map((id) => ({ id, verdict: "rejected" as const })),
  ];
  if (o.redo && o.reject) throw new Error("Use --redo or --reject, not both: each needs its own note.");
  if ((o.redo || o.reject) && picks.filter((p) => p.verdict !== "accepted").length > 1) throw new Error(`--${o.redo ? "redo" : "reject"} takes one task id, since the note is for that task.`);
  if (o.note !== undefined && !o.redo && !o.reject) throw new Error("--note goes with --redo or --reject.");
  if ((o.redo || o.reject) && !o.note?.trim()) throw new Error(`A ${o.redo ? "redo" : "reject"} needs a note: add --note "…".`);
  if (!picks.length) throw new Error("Name a task: --accept, --redo or --reject with a task id.");
  const twice = picks.find((p, i) => picks.findIndex((x) => x.id === p.id) !== i);
  if (twice) throw new Error(`${twice.id} is named twice. Decide each draft once.`);
  // Any draft waiting here can be decided by its identifier, as PMX's page can: the person named it.
  const { items, host } = await loadQueue(ctx, svc, { all: true });
  const byId = new Map(items.map((i) => [i.task.identifier.toUpperCase(), i]));
  const missing = picks.filter((p) => !byId.has(p.id)).map((p) => p.id);
  if (missing.length) {
    const waiting = items.length ? ` Waiting for review here: ${items.map((i) => i.task.identifier).join(", ")}.` : " Nothing is waiting for review here.";
    return { text: `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} waiting for review here, so nothing was decided.${waiting}`, code: 1 };
  }
  const lines: string[] = [];
  const made: (FollowUpResult | null)[] = [];
  for (const p of picks) {
    const d = await recordDecision(ctx, svc, host, byId.get(p.id)!, p.verdict, { note: p.verdict === "accepted" ? undefined : o.note, reviewMinutes: null });
    lines.push(d.message);
    made.push(d.followUps);
  }
  const hint = followUpHint(made);
  return { text: [...lines, ...(hint ? [hint] : [])].join("\n"), code: 0 };
}
