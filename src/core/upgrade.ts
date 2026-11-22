import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { APP_SKILL, appSkillInstalled, installAppSkill, refreshAppSkills, SETUP_SKILL, skillInstalledByPmx } from "../claude/skill.js";
import { installMcp, mcpInstalled } from "../mcp/server.js";
import { claudeAbsolutePath } from "./claude-bin.js";
import type { Exec } from "./exec.js";
import { jobEnv, plist, stableNode, type Launchd } from "./launchd.js";
import { paths, pmxHome } from "./paths.js";
import { loadState, updateState } from "./state.js";
import { isDevInstall } from "./update.js";
import { compareVersions, currentVersion } from "./version.js";

/**
 * UPGRADE-1: what an update needs on this Mac, done once per version, based on the version the Mac came from.
 *
 * `lastVersion` is the pmx that last ran any command here; when the running pmx differs, this Mac was upgraded (or,
 * rarely, downgraded) and `from` is where it came from. Each automatic step runs once: "every upgrade" steps once per
 * version (refreshing what an older pmx installed), one-off steps once per Mac when it came from before their
 * `since`. Steps that only a person or Claude can do are the checklist's (src/setup/checklist.ts), never here.
 */
export interface UpgradeRecord {
  lastVersion: string | null;
  /** The version this Mac came from at the last upgrade; null when it's unknown (a pmx from before 0.35.0, or none). */
  from: string | null;
  /** When the running version was first seen. */
  at: string | null;
  /** Each step done, keyed by its ID (one-off) or `<id>@<version>` (every upgrade): when, and what it did. */
  applied: Record<string, { at: string; did: string }>;
}

export interface UpgradeDeps {
  exec: Exec;
  launchd: Launchd;
  /** The pmx entry script that's running now. */
  cliPath: string;
  /** False in the background job: a step that reloads the job itself waits for a command someone runs. */
  interactive: boolean;
  now?: () => Date;
  /** Tests stand in for "this pmx runs from a source checkout". */
  devInstall?: () => Promise<boolean>;
}

export interface AutoStep {
  id: string;
  /** null: every upgrade. A version: once, on a Mac that came from before it (or from an unknown version). */
  since: string | null;
  title: string;
  /** Reloads the background job, so it never runs from inside that job. */
  interactiveOnly?: boolean;
  /** What it did, or null when there was nothing to do. Must check real state first, so running it twice is safe. */
  run(d: UpgradeDeps): Promise<string | null>;
}

const exists = (f: string) => stat(f).then(() => true, () => false);
const dev = (d: UpgradeDeps) => (d.devInstall ?? (() => isDevInstall()))();
const realCli = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export const AUTO_STEPS: AutoStep[] = [
  {
    id: "app-skills",
    since: null,
    title: "PMX's commands in the Claude app match this version",
    async run() {
      const updated: string[] = await refreshAppSkills();
      // /pmx-setup is new in 0.35.0: a Mac that already has PMX's other commands gets it too.
      if ((await skillInstalledByPmx(APP_SKILL)) && !(await appSkillInstalled(SETUP_SKILL)) && (await installAppSkill(SETUP_SKILL)) === "installed") updated.push(`${SETUP_SKILL} (new)`);
      return updated.length ? `updated ${updated.map((s) => `/${s}`).join(", ")}` : null;
    },
  },
  {
    id: "mcp-entry",
    since: null,
    title: "The Claude app starts this version's PMX server",
    async run(d) {
      if (!(await mcpInstalled()) || (await dev(d))) return null;
      const r = await installMcp(await stableNode(process.execPath), realCli(d.cliPath));
      if (r.error) throw new Error(r.error);
      return r.changed ? "pointed the Claude app's PMX server at this pmx" : null;
    },
  },
  {
    id: "background-job",
    since: null,
    title: "The background job runs this version with today's Node and Claude Code",
    interactiveOnly: true,
    async run(d) {
      const have = await d.launchd.installed();
      if (!have || (await dev(d))) return null;
      // A job that belongs to another PMX home (a second install on this Mac) is left alone.
      const home = have.match(/<key>PMX_HOME<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null;
      if (home !== pmxHome()) return null;
      // Reloading stops a pass that's running, which could leave a task half done: wait for the next command.
      if (await d.launchd.running?.()) throw new Error("the background job is running right now");
      const env = jobEnv(have);
      const claude = (await claudeAbsolutePath(d.exec)) ?? (env.PMX_CLAUDE && (await exists(env.PMX_CLAUDE)) ? env.PMX_CLAUDE : null);
      const want = plist({ node: await stableNode(process.execPath), cli: realCli(d.cliPath), pmxHome: pmxHome(), claude });
      if (want === have) return null;
      await d.launchd.install(want);
      return "refreshed the background job with this pmx, Node and Claude Code";
    },
  },
];

const keyOf = (s: AutoStep, version: string) => (s.since === null ? `${s.id}@${version}` : s.id);
const before = (v: string | null, since: string) => v === null || (compareVersions(v, since) ?? -1) < 0;
/** Whether a step applies to a Mac that came from `from` to `to`. */
export const applies = (s: AutoStep, from: string | null, to: string) => (s.since === null ? from !== to : before(from, s.since));

/** The record as it stands, seeded on a Mac whose pmx predates it from what NEW-1 remembers. */
export async function upgradeRecord(): Promise<UpgradeRecord> {
  const st = await loadState();
  return st.upgrade ?? { lastVersion: st.whatsNew?.since ?? st.whatsNew?.seen ?? null, from: null, at: null, applied: {} };
}

export interface UpgradeResult {
  from: string | null;
  to: string;
  /** Steps done in this call. */
  did: { id: string; title: string; did: string }[];
  /** Steps that apply but haven't run: interactive-only ones in the background job, or ones that failed. */
  waiting: { id: string; title: string; why: string }[];
}

/**
 * Runs before every command (but `mcp` and `uninstall`). Cheap when nothing changed: one read of state.json.
 */
export async function upgradeOnStart(d: UpgradeDeps, steps: AutoStep[] = AUTO_STEPS): Promise<UpgradeResult> {
  const now = (d.now ?? (() => new Date()))().toISOString();
  const to = currentVersion();
  const rec = await upgradeRecord();
  // A Mac that never ran pmx (no settings, no record) isn't upgrading: it starts at this version.
  if (rec.lastVersion === null && rec.at === null && !(await exists(paths.config()))) {
    await updateState((st) => { st.upgrade = { lastVersion: to, from: to, at: now, applied: {} }; });
    return { from: to, to, did: [], waiting: [] };
  }
  if (rec.lastVersion !== to) {
    // Keep the older starting point while a one-off step from that upgrade still waits, so it isn't skipped. A record
    // seeded from what NEW-1 remembers (never saved, so `at` is null) has no earlier upgrade.
    const unfinished = rec.at !== null && rec.lastVersion !== null && steps.some((s) => s.since !== null && applies(s, rec.from, rec.lastVersion!) && !rec.applied[s.id]);
    if (!unfinished) rec.from = rec.lastVersion;
    rec.lastVersion = to;
    rec.at = now;
  }
  const out: UpgradeResult = { from: rec.from, to, did: [], waiting: [] };
  for (const s of steps) {
    if (rec.at === null || !applies(s, rec.from, to) || rec.applied[keyOf(s, to)]) continue;
    if (s.interactiveOnly && !d.interactive) {
      out.waiting.push({ id: s.id, title: s.title, why: "waits for the next pmx command you run" });
      continue;
    }
    try {
      const did = (await s.run(d)) ?? "nothing to do";
      rec.applied[keyOf(s, to)] = { at: now, did };
      out.did.push({ id: s.id, title: s.title, did });
    } catch (e: any) {
      out.waiting.push({ id: s.id, title: s.title, why: e?.message ?? String(e) });
    }
  }
  // Keep the record small: steps for older versions only matter for the checklist's history of this upgrade.
  const keys = Object.keys(rec.applied);
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete rec.applied[k];
  await updateState((st) => { st.upgrade = rec; });
  return out;
}

/** A fresh `pmx init`: this Mac starts at this version, so no step for an older one applies. */
export async function markFreshInstall(now = new Date(), steps: AutoStep[] = AUTO_STEPS): Promise<void> {
  const v = currentVersion(), at = now.toISOString();
  const applied = Object.fromEntries(steps.map((s) => [keyOf(s, v), { at, did: "not needed: installed fresh" }]));
  await updateState((st) => { st.upgrade = { lastVersion: v, from: v, at, applied }; });
}
