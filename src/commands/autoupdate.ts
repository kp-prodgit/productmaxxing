import { refreshAppSkills } from "../claude/skill.js";
import { join } from "node:path";
import { autoUpdateOn } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { notify } from "../core/notify.js";
import { loadState, updateState } from "../core/state.js";
import { installTeamVersion } from "../core/update.js";
import { VENDORED_CLI } from "../core/vendor.js";
import { vendoredVersion } from "../core/version.js";
import type { TickStep } from "./tick.js";

const EVERY_MS = 3600000;

/**
 * The background auto-update (COMPAT-6). Unless the team turned it off (`cli.autoUpdate` false), each tick, at
 * most hourly, pulls the PMX repo and installs its CLI package if it's newer. It installs only the package the team's
 * repo carries, never one straight from npm or a release, so the team's code owners still decide the version. The
 * running pass finishes on the old version; the next pass uses the new one, and tells the PM once what's new and what's
 * left for them, or that nothing is (src/commands/after-update.ts). If npm needs sudo, PMX can't type a
 * password, so it says so once per version, in a notification and in `pmx doctor`.
 */
export const updateStep: TickStep = async (ctx: Ctx) => {
  // A newer pmx may ship newer Claude commands (/pmx-schedule, /pmx-board); keep the installed copies current.
  const refreshed = await refreshAppSkills().catch(() => []);
  const none = refreshed.length ? `updated Claude commands: ${refreshed.map((n) => `/${n}`).join(", ")}` : null;
  if (!autoUpdateOn(ctx.team)) return none;
  const s = await loadState();
  if (s.autoUpdate && ctx.now().getTime() - Date.parse(s.autoUpdate.checkedAt) < EVERY_MS) return null;
  // A team that never chose and whose repo carries no package has nothing to install: nothing is pulled or recorded,
  // as before updates were on by default. The team's repo is fast-forwarded by its own step (JOB-10), so a package
  // merged later is seen here.
  if (ctx.team.cli?.autoUpdate !== true && !(await vendoredVersion(join(ctx.personal.repoPath, VENDORED_CLI), ctx.exec))) return none;
  const r = await installTeamVersion(ctx.personal.repoPath, ctx.exec, { pull: await ctx.repo.hasRemote() });
  const version = "version" in r ? r.version : null;
  const tellOnce = (r.result === "needs-sudo" || r.result === "failed") && s.autoUpdate?.notifiedFor !== version;
  await updateState((st) => {
    st.autoUpdate = { checkedAt: ctx.now().toISOString(), result: r.result, version, notifiedFor: tellOnce ? version : st.autoUpdate?.notifiedFor ?? null };
  });
  if (r.result === "updated") {
    // Said once, by the new pmx: its first background run works out what the update still needs from a person, and
    // notifies with that one line (src/commands/after-update.ts). This pass finishes on the old version.
    return `auto-update: installed pmx ${r.version}`;
  }
  if (tellOnce) {
    const how = r.result === "needs-sudo" ? `Run: ${r.command}` : r.error;
    await notify("ProductMaxxing update waiting", `Your team is on pmx ${version}. ${r.result === "needs-sudo" ? "It needs your password: run pmx update in Terminal." : "The install failed: run pmx update."}`).catch(() => {});
    return `auto-update: pmx ${version} is waiting (${how})`;
  }
  return null;
};
