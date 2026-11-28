import { DEFAULT_TEAM, loadTeamConfig, validateTeamConfig, type TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { TEAM_CONFIG_FILE } from "../core/paths.js";
import { noteShared, parseGitHubRemote, shareBase, unsharedWork } from "../core/host.js";
import { loadState, updateState } from "../core/state.js";
import type { TickStep } from "./tick.js";

const EVERY_MS = 10 * 60000;
/** How long a checkout may stay behind before `pmx doctor` says so. */
export const TEAM_SYNC_STALE_MS = 24 * 3600000;

/**
 * Keeps this Mac's checkout of the team's PMX repo current (JOB-10), so every PM works from the same kinds of work,
 * size rubric and settings soon after a pull request merges, whether or not the team left automatic updates on.
 * At most every ten minutes, and only a fast-forward of the default branch with no changes to tracked files: it never
 * merges, rebases or touches a branch the PM is working on, and never takes a team config that wouldn't load. The
 * pass that pulls still runs on what it loaded; the next one uses the new files.
 *
 * D2-2: first, on a team repo that isn't on GitHub, accepts this Mac made that never reached the team's repo (one
 * refused because the team had newer work, one from before 0.38.0) go there, on top of the team's newer work, as an
 * accept does (`shareBase`): only PMX's own commits, never forced. When they can't, the line says why and what to run,
 * and `pmx status`, Needs you and `pmx doctor` say it until they're shared, instead of working from a stale checkout.
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
  const github = !!parseGitHubRemote((await ctx.repo.remoteUrl()) ?? "");
  const f = await git(["fetch", "--quiet", "origin", base]);
  if (f.code !== 0) {
    await record(`failed: ${last(f.stderr)}`);
    if (!github) await noteShared(ctx.repo, { pushed: 0, pulled: false, left: { why: "unreachable", accepts: 0, own: [], detail: last(f.stderr) } }, at);
    return null;
  }
  // A merged config this pmx can't load would stop every pass on this Mac; keep the one that works and say why.
  let refused: string | null = null;
  const shown = await git(["show", `origin/${base}:${TEAM_CONFIG_FILE}`]);
  if (shown.code === 0) {
    try { validateTeamConfig({ ...DEFAULT_TEAM, team: "team", ...JSON.parse(shown.stdout) } as TeamConfig); }
    catch (e: any) { refused = e.message; }
  }
  const tip = async () => (await ctx.repo.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${base}`])).stdout.trim();
  const before = await tip();
  let done: string | null = null;
  if (!github) {
    const shared = await shareBase(ctx.repo, base, { fetched: true, takeTheirs: refused === null });
    await noteShared(ctx.repo, shared, at);
    if (shared.pushed) done = `put ${shared.pushed} accepted draft${shared.pushed === 1 ? "" : "s"} from this Mac in your team's repo`;
    if (shared.left) {
      const u = (await unsharedWork(ctx.repo, { why: shared.left.why, detail: shared.left.detail ?? null }))?.text ?? `this Mac's ${base} has work your team's repo doesn't`;
      // Behind the team too: this Mac can't take its newer work until then, and says so rather than going on quietly.
      if ((await ctx.repo.raw(["merge-base", "--is-ancestor", `refs/remotes/origin/${base}`, `refs/heads/${base}`])).code !== 0) {
        await record(`failed: ${shared.left.why === "own" ? "your own commits on" : "accepted drafts on"} ${base} aren't in your team's repo`);
        return `team repo: ${u}; working from what's checked out until then`;
      }
      done = u;
    }
  }
  const said = (x: string | null) => (done || x ? `team repo: ${[done, x].filter(Boolean).join("; ")}` : null);

  const branch = (await ctx.repo.raw(["branch", "--show-current"])).stdout.trim();
  if (branch !== base) { await record(`skipped: on branch ${branch || "(detached)"}, not ${base}`); return said(null); }
  // Untracked files (a .DS_Store from Finder) don't count: a fast-forward never overwrites them, it refuses instead.
  if ((await ctx.repo.ok(["status", "--porcelain", "--untracked-files=no"])) !== "") { await record("skipped: the checkout has local changes"); return said(null); }
  if (refused !== null) {
    await record(`refused: ${refused}`);
    return said(`not taking the latest ${base}, its ${TEAM_CONFIG_FILE} doesn't load (${refused}); working from what's checked out`);
  }
  const m = await git(["merge", "--ff-only", "--quiet", `origin/${base}`]);
  if (m.code !== 0) {
    await record(`failed: ${last(m.stderr)}`);
    return said(`couldn't fast-forward ${base} (${last(m.stderr)}); working from what's checked out`);
  }
  await record("ok", true);
  if ((await tip()) === before) return said(null);
  const now = await loadTeamConfig(ctx.personal.repoPath).catch(() => null);
  const added = now ? Object.keys(now.categories).filter((c) => !Object.prototype.hasOwnProperty.call(ctx.team.categories, c)) : [];
  return said(`pulled the latest ${base}${added.length ? `; new kinds of work from your team: ${added.join(", ")}` : ""}`);
};

/** For `pmx doctor`: a checkout that hasn't followed the team's repo for a day, and why. Null when it's fine. */
export function teamSyncProblem(st: { teamSync?: { checkedAt: string; result: string; okAt?: string | null } | null }, now: Date): string | null {
  const t = st.teamSync;
  if (!t || t.result === "ok") return null;
  const since = t.okAt ? Date.parse(t.okAt) : null;
  if (since !== null && now.getTime() - since < TEAM_SYNC_STALE_MS) return null;
  return `this Mac hasn't picked up your team's merged changes ${since === null ? "yet" : `since ${t.okAt!.slice(0, 16).replace("T", " ")}`} (${t.result}). Your kinds of work and settings may differ from your teammates'; switch the PMX repo back to its default branch and commit or drop local changes.`;
}
