import { DEFAULT_TEAM, loadTeamConfig, validateTeamConfig, type TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { TEAM_CONFIG_FILE } from "../core/paths.js";
import { loadState, updateState } from "../core/state.js";
import type { TickStep } from "./tick.js";

const EVERY_MS = 10 * 60000;
/** How long a checkout may stay behind before `pmx doctor` says so. */
export const TEAM_SYNC_STALE_MS = 24 * 3600000;

/**
 * Keeps this Mac's checkout of the team's PMX repo current (JOB-10), so every PM works from the same kinds of work,
 * size rubric and settings soon after a pull request merges, whether or not the team turned on automatic updates.
 * At most every ten minutes, and only a fast-forward of the default branch with no changes to tracked files: it never
 * merges, rebases or touches a branch the PM is working on, and never takes a team config that wouldn't load. The
 * pass that pulls still runs on what it loaded; the next one uses the new files.
 */
export const teamSyncStep: TickStep = async (ctx: Ctx) => {
  if (!(await ctx.repo.hasRemote())) return null;
  const s = await loadState();
  if (s.teamSync && ctx.now().getTime() - Date.parse(s.teamSync.checkedAt) < EVERY_MS) return null;
  const at = ctx.now().toISOString();
  const record = (result: string, ok = false) => updateState((st) => { st.teamSync = { checkedAt: at, result, okAt: ok ? at : st.teamSync?.okAt ?? null }; });
  const git = (args: string[]) => ctx.exec("git", ["-C", ctx.personal.repoPath, ...args], { timeoutMs: 60000 });
  const last = (t: string) => t.trim().split("\n").pop() || "git failed";

  const base = await ctx.repo.defaultBranch();
  const branch = (await ctx.repo.raw(["branch", "--show-current"])).stdout.trim();
  if (branch !== base) { await record(`skipped: on branch ${branch || "(detached)"}, not ${base}`); return null; }
  // Untracked files (a .DS_Store from Finder) don't count: a fast-forward never overwrites them, it refuses instead.
  if ((await ctx.repo.ok(["status", "--porcelain", "--untracked-files=no"])) !== "") { await record("skipped: the checkout has local changes"); return null; }

  const f = await git(["fetch", "--quiet", "origin", base]);
  if (f.code !== 0) { await record(`failed: ${last(f.stderr)}`); return null; }
  // A merged config this pmx can't load would stop every pass on this Mac; keep the one that works and say why.
  const shown = await git(["show", `origin/${base}:${TEAM_CONFIG_FILE}`]);
  if (shown.code === 0) {
    try { validateTeamConfig({ ...DEFAULT_TEAM, team: "team", ...JSON.parse(shown.stdout) } as TeamConfig); }
    catch (e: any) {
      await record(`refused: ${e.message}`);
      return `team repo: not taking the latest ${base}, its ${TEAM_CONFIG_FILE} doesn't load (${e.message}); working from what's checked out`;
    }
  }
  const before = await ctx.repo.head();
  const m = await git(["merge", "--ff-only", "--quiet", `origin/${base}`]);
  if (m.code !== 0) {
    await record(`failed: ${last(m.stderr)}`);
    return `team repo: couldn't fast-forward ${base} (${last(m.stderr)}); working from what's checked out`;
  }
  await record("ok", true);
  if ((await ctx.repo.head()) === before) return null;
  const now = await loadTeamConfig(ctx.personal.repoPath).catch(() => null);
  const added = now ? Object.keys(now.categories).filter((c) => !Object.prototype.hasOwnProperty.call(ctx.team.categories, c)) : [];
  return `team repo: pulled the latest ${base}${added.length ? `; new kinds of work from your team: ${added.join(", ")}` : ""}`;
};

/** For `pmx doctor`: a checkout that hasn't followed the team's repo for a day, and why. Null when it's fine. */
export function teamSyncProblem(st: { teamSync?: { checkedAt: string; result: string; okAt?: string | null } | null }, now: Date): string | null {
  const t = st.teamSync;
  if (!t || t.result === "ok") return null;
  const since = t.okAt ? Date.parse(t.okAt) : null;
  if (since !== null && now.getTime() - since < TEAM_SYNC_STALE_MS) return null;
  return `this Mac hasn't picked up your team's merged changes ${since === null ? "yet" : `since ${t.okAt!.slice(0, 16).replace("T", " ")}`} (${t.result}). Your kinds of work and settings may differ from your teammates'; switch the PMX repo back to its default branch and commit or drop local changes.`;
}
