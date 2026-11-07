import type { PersonalConfig, TeamConfig } from "../core/config.js";
import { loadState, type State } from "../core/state.js";

export interface Budget {
  remainingUsd: number;
  /** The cap that applies: the PM's own, or the team's when the PM has none. */
  capUsd: number;
  /** The PM's own cap; null when they have none (BUDGET-1). */
  personalCapUsd: number | null;
  /** Tokens PMX's runs used today, as Claude Code reports them. */
  tokens: number;
  spentUsd: number;
  resetAt: Date;
  minutesToReset: number;
  source: "override" | "ledger";
}

/** The ledger day a timestamp falls in, given the reset hour (local time). */
export function ledgerDay(d: Date, resetHour: number): string {
  const shifted = new Date(d.getTime() - resetHour * 3600000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function nextReset(now: Date, resetHour: number): Date {
  const r = new Date(now);
  r.setHours(resetHour, 0, 0, 0);
  if (r <= now) r.setDate(r.getDate() + 1);
  return r;
}

/**
 * The budget provider (PULL-5), framed as spend caps and pacing (P10).
 * Order: an official usage source (none exists yet, Q1), then the self-tracked ledger against the
 * declared daily cap, then a manual override. The team's per-machine daily cap always wins (SEC-6).
 */
export function budget(p: PersonalConfig, team: TeamConfig, s: State, now: Date): Budget {
  const resetAt = nextReset(now, p.budget.resetHour);
  const minutesToReset = Math.round((resetAt.getTime() - now.getTime()) / 60000);
  const personalCapUsd = p.budget.dailyUsd ?? null;
  const capUsd = Math.min(personalCapUsd ?? Infinity, team.caps.perDayUsd);
  const day = ledgerDay(now, p.budget.resetHour);
  const spentUsd = s.ledger[day] ?? 0;
  const base = { capUsd, personalCapUsd, tokens: s.tokens?.[day] ?? 0, spentUsd, resetAt, minutesToReset };
  if (p.budget.overrideUsd != null) {
    return { ...base, remainingUsd: Math.max(0, Math.min(p.budget.overrideUsd, team.caps.perDayUsd - spentUsd)), source: "override" };
  }
  return { ...base, remainingUsd: Math.max(0, capUsd - spentUsd), source: "ledger" };
}

/**
 * Why no model run may start now, or null (BUDGET-2). Every run that calls the model asks first, so a cap of 0 or a
 * used-up day stops to-dos, digests, synthesis, roll-ups and pulls alike.
 */
export function budgetBlock(b: Budget): string | null {
  if (b.personalCapUsd === 0) return "PMX is paused: your daily cap is $0. Turn it back on with `pmx budget set <dollars>` or `pmx budget off`";
  if (b.remainingUsd <= 0) return `today's PMX budget is used up ($${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)}, estimated at list prices); it resets in ${Math.floor(b.minutesToReset / 60)}h ${b.minutesToReset % 60}m. Change it with \`pmx budget set <dollars>\``;
  return null;
}

/** Thrown before a model run when the budget says no. The background job reports it as a skip, not a failure. */
export class BudgetPaused extends Error {
  readonly budgetPaused = true;
}

export function assertBudget(p: PersonalConfig, team: TeamConfig, s: State, now: Date): void {
  const why = budgetBlock(budget(p, team, s, now));
  if (why) throw new BudgetPaused(`${why[0]!.toUpperCase()}${why.slice(1)}.`);
}

/** `assertBudget` with this run's config and today's ledger. Call it right before the model is. */
export async function checkBudget(ctx: { personal: PersonalConfig; team: TeamConfig; now: () => Date }): Promise<void> {
  assertBudget(ctx.personal, ctx.team, await loadState(), ctx.now());
}

export function recordSpend(s: State, p: PersonalConfig, now: Date, usd: number | null, tokens?: number | null): void {
  const day = ledgerDay(now, p.budget.resetHour);
  if (tokens) s.tokens = { ...s.tokens, [day]: (s.tokens?.[day] ?? 0) + tokens };
  if (!usd) return;
  s.ledger[day] = Math.round(((s.ledger[day] ?? 0) + usd) * 10000) / 10000;
  if (p.budget.dailyUsd !== null) s.caps = { ...s.caps, [day]: p.budget.dailyUsd };
}

/** One line on today's usage, in tokens first: on a Claude plan the dollars are an estimate, not a bill. */
export function usageLine(b: Budget, plan: PersonalConfig["plan"]): string {
  const tokens = b.tokens >= 1000 ? `${Math.round(b.tokens / 1000)}k tokens` : `${b.tokens} tokens`;
  const billed = plan === "api" || plan === "bedrock" || plan === "vertex";
  const usd = `$${b.spentUsd.toFixed(2)}${billed ? "" : " at API list prices (your Claude plan isn't billed per token)"}`;
  const cap = b.personalCapUsd === 0 ? "PAUSED: your daily cap is $0 (`pmx budget set <dollars>` or `pmx budget off`)"
    : b.personalCapUsd === null ? `no cap of your own; team cap $${b.capUsd.toFixed(2)}`
    : `cap $${b.capUsd.toFixed(2)}`;
  return `Usage today: ${tokens}, ${usd}; ${cap}${b.source === "override" ? " (override)" : ""}; resets in ${Math.floor(b.minutesToReset / 60)}h ${b.minutesToReset % 60}m`;
}
