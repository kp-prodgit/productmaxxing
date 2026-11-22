import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { chmod, mkdir, stat } from "node:fs/promises";
import { setTaskHours } from "../claude/tasks.js";
import { addAllowRules } from "../claude/permissions.js";
import { BOARD_SKILL, FLOW_SKILL, installAppSkill, SETUP_SKILL, type AppSkill } from "../claude/skill.js";
import { claudeAbsolutePath } from "../core/claude-bin.js";
import type { Ctx } from "../core/context.js";
import { plist, stableNode } from "../core/launchd.js";
import { paths, pmxHome } from "../core/paths.js";
import { updateState } from "../core/state.js";
import { installTeamVersion, isDevInstall, type UpdateOutcome } from "../core/update.js";
import { packageRoot } from "../core/skills.js";
import { ENGINE_PACKAGE, installEnginePackage, PMX_PACKAGE, prefixOf } from "./install.js";
import { AUTO_STEPS, type AutoStep } from "../core/upgrade.js";
import { currentVersion } from "../core/version.js";
import { startJob } from "../flow/jobs.js";
import { installMcp, mcpInstalled } from "../mcp/server.js";
import type { Checklist, Step } from "./checklist.js";

/**
 * SETUP-2: the setup checklist's steps PMX can do itself on this Mac, from a button on its page, `board_act`'s
 * `checklist-fix` or `pmx checklist --fix <step>`. An allowlist from step ID to code: a step's `do` text is advice for
 * people and Claude, and is never run. A fix runs only while its step is open and the checklist says PMX does it
 * (`fix.kind` "pmx"). One that changes the background job, the Claude app's settings or PMX's own install asks the PM
 * on the Mac first (the pairing dialog), except what an update already does unattended (refreshing PMX's commands in
 * the Claude app and its server entry, src/core/upgrade.ts).
 */
export interface FixDeps {
  ctx: Ctx;
  /**
   * Asks the PM on this Mac whether PMX may do `what` ("turn on PMX's background job…"): the page's fixes ask with the
   * pairing dialog (`pagePrompt`), `pmx checklist --fix` in Terminal.
   */
  confirm: (what: string) => Promise<boolean>;
  /** The pmx entry script to point the background job and the Claude app at. */
  cliPath?: string;
  /** Tests stand in for "this pmx runs from a source checkout", and for installing pmx. */
  devInstall?: () => Promise<boolean>;
  update?: () => Promise<UpdateOutcome>;
  /** Tests stand in for the home folder a new install may use (~/.local) and for which folders this user can write. */
  home?: string;
  writable?: (dir: string) => Promise<boolean>;
}

interface Fix {
  /** What PMX asks the PM before it does it, or null when it doesn't need to. */
  asks(d: FixDeps): Promise<string | null>;
  /** What it did, in the page's words. Throws when it couldn't. */
  run(d: FixDeps): Promise<string>;
}

/** The dialog a fix from the page shows on the Mac, in the pairing dialog's words. */
export const pagePrompt = (what: string) => `Your PMX page wants to ${what}.\n\nAllow it only if you just clicked it on your PMX page.`;
const ask = (what: string) => async () => what;
const never = async () => null;
const cliOf = (d: FixDeps) => { const c = d.cliPath ?? process.argv[1] ?? ""; try { return realpathSync(c); } catch { return c; } };
const exists = (f: string) => stat(f).then(() => true, () => false);

async function installJob(d: FixDeps): Promise<string> {
  await mkdir(paths.logs(), { recursive: true });
  const claude = await claudeAbsolutePath(d.ctx.exec);
  await d.ctx.launchd.install(plist({ node: await stableNode(process.execPath), cli: cliOf(d), pmxHome: pmxHome(), claude }));
  return "Automatic runs are on. PMX checks every 30 minutes while this Mac is awake.";
}

/** An update step (UPGRADE-1) done now, and recorded the way an update records it, so the checklist shows it done. */
async function autoStep(step: AutoStep, d: FixDeps): Promise<string> {
  const did = (await step.run({ exec: d.ctx.exec, launchd: d.ctx.launchd, cliPath: cliOf(d), interactive: true, now: d.ctx.now, devInstall: d.devInstall })) ?? "nothing to do";
  const at = d.ctx.now().toISOString(), v = currentVersion();
  await updateState((st) => { if (st.upgrade) st.upgrade.applied[step.since === null ? `${step.id}@${v}` : step.id] = { at, did }; });
  return did === "nothing to do" ? `${step.title}: nothing needed doing.` : `Done: ${did}.`;
}

async function skill(name: AppSkill, after: string): Promise<string> {
  const r = await installAppSkill(name);
  if (r === "kept-yours") return `/${name} in the Claude app is your own copy, so PMX left it alone.`;
  return `/${name} is in the Claude app. ${after}`;
}

async function update(d: FixDeps): Promise<string> {
  const r = await (d.update ?? (async () => installTeamVersion(d.ctx.personal.repoPath, d.ctx.exec, { pull: await d.ctx.repo.hasRemote().catch(() => false) })))();
  if (r.result === "updated") return `Installed pmx ${r.version}. PMX's server in the Claude app and the background job use it from their next start.`;
  if (r.result === "current") return "PMX is already at your team's version.";
  if (r.result === "no-package") throw new Error("Your team has no PMX version to install yet: your team lead adds it.");
  if (r.result === "dev-install") throw new Error("This PMX runs from a source checkout, so it isn't replaced.");
  if (r.result === "needs-sudo") throw new Error("Installing it needs your Mac's password, which PMX never asks for. In the Claude app, type /pmx-setup and Claude helps you install it.");
  throw new Error(`The install failed: ${r.error}`);
}

const AUTO = (id: string) => AUTO_STEPS.find((s) => s.id === id)!;

/**
 * INSTALL-4: PMX Engine for the team's product lead, the checklist's Install PMX Engine button. npm installs it where PMX
 * itself is installed (or by the same rule as a new install: npm's own folder when it's writable, else ~/.local), never
 * with sudo. Engine's own steps then follow PMX's in Setup.
 */
async function installEngine(d: FixDeps): Promise<string> {
  const root = process.env.PMX_INSTALL_ROOT_FOR_TESTS ?? packageRoot();
  let real = root;
  try { real = realpathSync(root); } catch { /* as given */ }
  const r = await installEnginePackage({ exec: d.ctx.exec, home: d.home ?? homedir(), pmxPrefix: prefixOf(root, PMX_PACKAGE) ?? prefixOf(real, PMX_PACKAGE), writable: d.writable });
  if (r.ok) return "PMX Engine is installed. Its own steps now follow PMX's here in Setup.";
  if (r.denied) throw new Error(`npm can't write to ${r.prefix} without your Mac's password, which PMX never asks for. In the Claude app, type /pmx-setup and Claude helps you install it.`);
  throw new Error(`npm couldn't install ${ENGINE_PACKAGE}: ${r.error}`);
}

export const FIXES: Record<string, Fix> = {
  "job.installed": { asks: ask("turn on PMX's background job on this Mac, so PMX checks every 30 minutes on its own"), run: installJob },
  "job.paths": { asks: ask("rewrite PMX's background job with today's Node and Claude Code"), run: (d) => autoStep(AUTO("background-job"), d) },
  "job.passes": {
    asks: never,
    async run(d) {
      const r = startJob(d.ctx, "tick");
      if (r.status >= 400) throw new Error((r.body as { error: string }).error);
      return "Started a run. It takes a few minutes; Activity shows what it did.";
    },
  },
  "mac.pmx": { asks: ask("install your team's PMX version on this Mac"), run: update },
  "setup.package": { asks: ask("install your team's PMX version on this Mac"), run: update },
  "cli.auto-update": { asks: ask("install your team's PMX version on this Mac"), run: update },
  // Only the team's product lead has this step open (src/setup/checklist.ts); for everyone else it doesn't apply.
  "engine.installed": { asks: ask("install PMX Engine, your team's product lead's tool, on this Mac"), run: installEngine },
  "setup.home.private": {
    asks: never,
    async run() {
      for (const dir of [paths.home(), paths.staging(), paths.receipts(), paths.transcripts()]) if (await exists(dir)) await chmod(dir, 0o700);
      return "PMX's folders are private to you again.";
    },
  },
  // Adding PMX's own commands is what every update does unattended (the "app-skills" step).
  "claude.setup": { asks: never, run: () => skill(SETUP_SKILL, "If it doesn't show yet, quit and reopen the Claude app.") },
  "claude.page": { asks: never, run: () => skill(FLOW_SKILL, "Type /pmx-flow there to publish PMX's page.") },
  "claude.board": { asks: never, run: () => skill(BOARD_SKILL, "Type /pmx-board there to publish your team's board.") },
  "claude.allow": {
    asks: ask("let PMX's scheduled tasks run PMX and use its ~/.pmx folder without stopping to ask, by adding always-allow rules to your Claude settings"),
    async run() {
      const r = await addAllowRules();
      if (r.error) throw new Error(r.error);
      return r.added.length ? "PMX's scheduled tasks may now run PMX without asking." : "Your Claude settings already allow PMX's tasks.";
    },
  },
  // Pointing an entry that's there at this pmx is what every update does; adding one where there's none asks first.
  "claude.mcp": {
    asks: async () => ((await mcpInstalled()) ? null : "register PMX's server with the Claude app on this Mac"),
    async run(d) {
      if (await (d.devInstall ?? (() => isDevInstall()))() && (await mcpInstalled())) return "This PMX runs from a source checkout, so the Claude app's entry for it was left as it is.";
      const r = await installMcp(await stableNode(process.execPath), cliOf(d));
      if (r.error) throw new Error(r.error);
      return `${r.changed ? "The Claude app now starts this PMX's server." : "The Claude app already starts this PMX's server."} Quit the Claude app completely (⌘Q) and open it again.`;
    },
  },
  // CLAUDE-6: the hours are PMX's own setting from 0.36.0, so nothing changes in the Claude app.
  "linear.hours": { asks: never, run: (d) => setTaskHours(d.ctx.personal, "always") },
  "update.app-skills": { asks: never, run: (d) => autoStep(AUTO("app-skills"), d) },
  "update.mcp-entry": { asks: never, run: (d) => autoStep(AUTO("mcp-entry"), d) },
  "update.background-job": { asks: ask("rewrite PMX's background job with this PMX, today's Node and Claude Code"), run: (d) => autoStep(AUTO("background-job"), d) },
};

export interface FixResult { status: number; message: string; done?: boolean }

const open = (s: Step) => s.status === "todo" || s.status === "warn";

/**
 * Runs one step's fix: only an allowlisted step that `current` (the checklist as PMX last worked it out) shows open
 * and as PMX's to do. Never runs anything from the step's text.
 */
export async function runFix(id: string, current: Checklist | null, d: FixDeps): Promise<FixResult> {
  const fix = Object.hasOwn(FIXES, id) ? FIXES[id] : undefined;
  if (!fix) return { status: 404, message: "PMX can't do that step itself." };
  const step = current?.sections.flatMap((s) => s.steps).find((s) => s.id === id);
  if (!step || !open(step)) return { status: 409, message: "That step is already done, or doesn't apply on this Mac." };
  if (step.fix?.kind !== "pmx") return { status: 409, message: step.fix?.text ?? "PMX can't do this one itself." };
  const prompt = await fix.asks(d);
  if (prompt && !(await d.confirm(prompt))) return { status: 409, message: "Nothing changed: you chose Don't Allow on the Mac, or nobody answered." };
  try { return { status: 200, message: await fix.run(d), done: true }; }
  catch (e: any) { return { status: 500, message: String(e?.message ?? e).replace(/`([^`]+)`/g, "$1") }; }
}
