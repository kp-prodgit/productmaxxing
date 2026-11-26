import { join } from "node:path";
import { agentHandle, isProductLead, startsNow, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { channelInputs, collectsChannels, NO_SYNTH_MAC } from "../inputs/inputs.js";
import { readJson, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { TICK_GAP_MS, type State } from "../core/state.js";
import { AUTO_STEPS, applies, type UpgradeRecord } from "../core/upgrade.js";
import { compareVersions } from "../core/version.js";
import { selfUpdating } from "../claude/pages.js";
import type { DoctorCheck } from "../commands/doctor.js";

/**
 * SETUP-1: where this Mac stands with PMX, step by step, worked out from what's actually here each time (never from
 * what someone remembers). The same shape as `pmxe checklist --json`, so Claude reads both the same way.
 *
 * A step is `done`, `todo` (something to do), `warn` (works, but something's off) or `skip` (doesn't apply here).
 * `required` steps are the ones PMX can't do its job without. `do` is the exact next action, `who` does it and `how`
 * says where. `page` is the same advice in words PMX's page may show: it names no terminal commands.
 */
export type StepStatus = "done" | "todo" | "warn" | "skip";
export type Who = "you" | "claude" | "teammate" | "team-lead";
export type How = "terminal" | "claude" | "app" | "linear" | "page";

export interface Step {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
  do?: string;
  who?: Who;
  how?: How;
  required: boolean;
  /** When this step was first seen done on this Mac (from ~/.pmx/checklist.json). */
  since?: string | null;
  /** The advice for PMX's page, without terminal commands. */
  page?: string;
  /** Part of what an update to this version still needs (UPGRADE-1). */
  afterUpdate?: boolean;
  /** SETUP-2: who can do an open step and how PMX's page offers it: a button, a slash command, a sentence or a place. */
  fix?: StepFix;
}

/**
 * SETUP-2: how an open step gets done, for PMX's page.
 *  - "pmx": PMX can do it on this Mac. The page shows a button (`label`) that runs it through the allowlist in
 *    src/setup/fix.ts, never the step's `do` text. `asks`: PMX asks on the Mac first (the background job, the Claude
 *    app's settings, installing pmx).
 *  - "claude": Claude does it: the page shows "In the Claude app, type <command>" with a Copy button.
 *  - "person": only a person can, somewhere else (a sign-in, a teammate's step): one sentence, and a link if one exists.
 *  - "page": a place on PMX's page does it (`to`: "tab:<route>" or "rule:<settings section>").
 */
export type FixKind = "pmx" | "claude" | "person" | "page";
export interface StepFix { kind: FixKind; label?: string; asks?: boolean; command?: string; text?: string; link?: string; to?: string }

export interface Section { id: string; title: string; steps: Step[] }

export interface Checklist {
  format: 1;
  tool: "pmx";
  version: string;
  at: string;
  where: string;
  next: Step | null;
  sections: Section[];
  counts: Record<StepStatus, number>;
  upgrade: { from: string | null; to: string; at: string | null; applied: { id: string; title: string; at: string; did: string }[]; pending: Step[] } | null;
}

/**
 * PMX Engine on this Mac, for PMX's own "PMX and PMX Engine" section: its version, and whether it has a checklist of its
 * own (SETUP-3: `pmx checklist` and Health → Setup show Engine's sections after PMX's, read live; they're never part of
 * PMX's checklist, its counts or its next step, nor recorded in ~/.pmx/checklist.json, which the `checklist` MCP tool
 * reads). `problem` when it's installed but didn't start.
 */
export type EngineSummary = { version: string; checklist: unknown } | { problem: { path: string; reason: string } };

/** Everything the checklist is worked out from. Gathered on the Mac (src/setup/gather.ts); plain data here, so it's testable. */
export interface ChecklistInputs {
  now: Date;
  version: string;
  personal: PersonalConfig | null;
  team: TeamConfig | null;
  checks: DoctorCheck[];
  state: State;
  claude: boolean;
  /** Whether the team repo has a git remote; null without a repo. */
  hasRemote: boolean | null;
  /** Whether the team memory says anything yet; null when PMX can't tell. */
  memoryFilled: boolean | null;
  proposals: number | null;
  /** Tasks in Linear as PMX last saw them; null when it can't count them without asking Linear. */
  tasks: { pool: number; ready: number; blocked: number } | null;
  /** When the first week's practice mode ends, or null once agents run for real. */
  practiceUntil: string | null;
  lastRun: { taskId: string; outcome: string; ts: string } | null;
  setupSkill: "current" | "outdated" | "missing" | "yours";
  /** The Linear sync task's schedule, when it's PMX's relay that syncs. */
  linearCron: string | null;
  /**
   * PMX Engine on this Mac: its own checklist's summary; `problem` when it's installed but didn't start (where, and why);
   * null when it isn't installed.
   */
  engine: EngineSummary | null;
  /** Steps from team features (ee/): the brain. */
  extra: Step[];
  /** Which of PMX's own commands are in the Claude app (SETUP-2: PMX adds a missing one itself). */
  appSkills?: { flow: boolean; board: boolean };
  /** Whether the Claude app has an entry for PMX's server, so repairing it changes nothing new in the app's settings. */
  mcpRegistered?: boolean;
}

/** The one place PMX's page sends a PM for terminal steps: Claude, with this guide. */
export const PAGE_HINT = "In the Claude app, type /pmx-setup and Claude does it with you.";
const RUN_FIX = "pmx checklist --fix";

const pmxFix = (label: string, text: string, asks = false): StepFix => ({ kind: "pmx", label, text, ...(asks ? { asks: true } : {}) });
const claudeFix = (command: string, text?: string): StepFix => ({ kind: "claude", command, text: text ?? `In the Claude app, type ${command} and Claude does it with you.` });
const personFix = (text: string, link?: string): StepFix => ({ kind: "person", text, ...(link ? { link } : {}) });
const placeFix = (label: string, to: string, text?: string): StepFix => ({ kind: "page", label, to, ...(text ? { text } : {}) });
const SETUP_FIX = claudeFix("/pmx-setup");
const UPDATE_FIX = pmxFix("Update PMX", "PMX installs your team's version on this Mac. It asks you on the Mac first.", true);

const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const day = (iso: string) => new Date(iso).toDateString().slice(4, 10);
const ago = (now: Date, iso: string) => { const h = (now.getTime() - Date.parse(iso)) / 3600000; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} days`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clean = (s: string) => s.replace(/^\s*[✔✘!]\s*/, "");


/** CLAUDE-6: from 0.36.0, working hours are PMX's own setting (src/claude/tasks.ts). */
const HOURS_SINCE = "0.36.0";

/** An open step's fix when its definition names none (team features' steps): by who does it and where (SETUP-2). */
function fallbackFix(s: Step): StepFix {
  const slash = s.do?.match(/(^|\s)(\/pmxe?-[a-z-]+)/)?.[2];
  if (slash) return claudeFix(slash);
  if (s.how === "terminal") return SETUP_FIX;
  return personFix(pageWords(s.page ?? s.do ?? s.detail) || PAGE_HINT);
}

export function buildChecklist(i: ChecklistInputs): Checklist {
  const c = (id: string) => i.checks.find((x) => x.id === id);
  const bad = (id: string) => { const x = c(id); return x && !x.ok ? x : null; };
  // An open step's fix (SETUP-2), and its words for the page: the fix's own when it has them.
  const step = (s: Step): Step => {
    if (s.status === "done" || s.status === "skip") { const { fix: _f, ...rest } = s; return rest; }
    const fix = s.fix ?? fallbackFix(s);
    return { ...s, fix, page: s.page ?? fix.text ?? (s.how === "terminal" ? PAGE_HINT : s.do) };
  };
  // `as`: the step's own ID where it isn't the doctor check's (the background job is job.installed, as the guide says).
  const fromCheck = (check: string, title: string, o: { required: boolean; do?: string; who?: Who; how?: How; skip?: string; fix?: StepFix; as?: string }): Step => {
    const x = c(check), id = o.as ?? check;
    if (!x) return step({ id, title, status: "skip", detail: o.skip ?? "doesn't apply on this Mac", required: false });
    return step({ id, title, status: x.ok ? "done" : x.level === "fail" ? "todo" : "warn", detail: clean(x.detail), required: o.required, ...(x.ok ? {} : { do: o.do, who: o.who, how: o.how, fix: o.fix }) });
  };
  const p = i.personal, team = i.team;
  const rec = i.state.upgrade ?? null;
  const from = rec?.from ?? null;
  const updatedHere = !!rec && rec.from !== rec.lastVersion;
  const since = (v: string) => updatedHere && (from === null || (compareVersions(from, v) ?? -1) < 0);
  /** Whether this pmx's page updates itself (FLOW-8): it does from 0.36.0. */
  const selfUpdateHere = selfUpdating(i.version);

  // ---- This Mac
  const mac: Step[] = [
    fromCheck("os.macos", "This Mac runs macOS", { required: true, do: "PMX runs on macOS only for now.", fix: personFix("PMX runs on macOS only for now.") }),
    (() => {
      const n = c("node"), vm = bad("node.path");
      if (n && !n.ok) return step({ id: "mac.node", title: "Node 22.12 or later", status: "todo", detail: clean(n.detail), do: "brew install node, then reinstall pmx (INSTALL.md step 2) and run pmx init", who: "you", how: "terminal", required: true, fix: claudeFix("/pmx-setup", "In the Claude app, type /pmx-setup: Claude installs a supported Node with you and sets PMX up again.") });
      return step({ id: "mac.node", title: "Node 22.12 or later", status: vm ? "warn" : "done", detail: clean((vm ?? n)?.detail ?? `Node ${process.versions.node}`), ...(vm ? { do: "brew install node, reinstall pmx, then pmx init", who: "you" as const, how: "terminal" as const, fix: claudeFix("/pmx-setup", "In the Claude app, type /pmx-setup: Claude installs a Node that stays put with you and sets PMX up again.") } : {}), required: true });
    })(),
    fromCheck("claude.installed", "Claude Code is installed", { required: true, do: "Install Claude Code from https://code.claude.com", who: "you", how: "app", fix: personFix("Install Claude Code, then open this page again.", "https://code.claude.com") }),
    (() => {
      const min = bad("cli.team-minimum"), latest = bad("cli.latest");
      if (min) return step({ id: "mac.pmx", title: "PMX is at your team's version", status: "todo", detail: clean(min.detail), do: "pmx update", who: "you", how: "terminal", required: true, fix: UPDATE_FIX });
      if (latest) return step({ id: "mac.pmx", title: "PMX is at your team's version", status: "warn", detail: `pmx ${i.version}; ${clean(latest.detail)}`, do: "Team lead: pmx update --latest, then pmx vendor --require in a pull request. Everyone else: pmx update once it merges.", who: "team-lead", how: "terminal", required: false, fix: personFix("Your team lead moves the team to the newest PMX; you get it once they do.") });
      return step({ id: "mac.pmx", title: "PMX is at your team's version", status: "done", detail: `pmx ${i.version}`, required: true });
    })(),
    // pmx init offers this sign-in, so before init it isn't a step of its own.
    p ? fromCheck("profile.signed-in", "PMX's own Claude profile is signed in", { required: true, do: "pmx claude login", who: "you", how: "terminal", skip: "needs Claude Code first",
      fix: personFix("Only you can sign in PMX's own Claude profile, once. In the Claude app, type /pmx-setup and Claude shows you how.") })
      : step({ id: "profile.signed-in", title: "PMX's own Claude profile is signed in", status: "skip", detail: "pmx init offers this sign-in", required: true }),
  ];

  // ---- Your PMX setup
  const setup: Step[] = [
    !p
      ? step({ id: "setup.config", title: "PMX is set up on this Mac", status: "todo", detail: "PMX is installed but not set up: there's no ~/.pmx/config.json yet.", do: "pmx init (you answer its questions in Terminal; it saves nothing until you confirm)", who: "you", how: "terminal", required: true, fix: claudeFix("/pmx-setup", "In the Claude app, type /pmx-setup: Claude sets PMX up with you, and nothing is saved until you confirm.") })
      : step({ id: "setup.config", title: "PMX is set up on this Mac", status: "done", detail: `set up ${day(p.installedAt)} as ${p.handle}, team repo ${p.repoPath}`, required: true }),
    p ? fromCheck("config.team", "Your team's settings are readable", { required: true, do: "Fix pmx.config.json in your team repo, or run pmx init again", who: "you", how: "terminal" }) : step({ id: "config.team", title: "Your team's settings are readable", status: "skip", detail: "after pmx init", required: true }),
    i.hasRemote === null
      ? step({ id: "setup.remote", title: "Your team repo is shared", status: "skip", detail: "after pmx init", required: false })
      : step({
        id: "setup.remote", title: "Your team repo is shared", status: i.hasRemote ? "done" : "warn", required: false,
        detail: i.hasRemote ? "the team repo has a remote, so teammates share settings, skills, digests and the run log" : "your team repo has no remote, so it lives on this Mac only: teammates can't join it, team setting changes become local branches you apply yourself, and digests and the run log stay here",
        ...(i.hasRemote ? {} : { do: `Create an empty private GitHub repository, then in ${p?.repoPath ?? "your team repo"}: git remote add origin <its URL> && git push -u origin main`, who: "team-lead" as const, how: "terminal" as const,
          fix: personFix("Your team lead shares your team's PMX settings online so teammates can join; until then they stay on this Mac.", "https://github.com/new") }),
      }),
    (() => {
      const x = bad("cli.team-package");
      if (!x) return step({ id: "setup.package", title: "Your team repo carries this PMX version", status: c("cli.team-package") ? "done" : "skip", detail: c("cli.team-package") ? clean(c("cli.team-package")!.detail) : "no team package to compare", required: false });
      const newer = /run `pmx update`/.test(x.detail);
      return step({ id: "setup.package", title: "Your team repo carries this PMX version", status: "warn", detail: clean(x.detail), required: false, afterUpdate: !newer,
        do: newer ? "pmx update" : "pmx vendor --require, then commit .pmx/cli and pmx.config.json in a pull request (or straight to main when the repo has no remote)", who: newer ? "you" : "team-lead", how: "terminal",
        fix: newer ? UPDATE_FIX : personFix("Your team lead shares this PMX version with the team, so teammates who update get it too.") });
    })(),
    (() => {
      const d = bad("privacy.company-domains") ?? bad("privacy.canaries");
      return step({ id: "setup.privacy", title: "Privacy rules know your company and hold private meetings", status: !c("privacy.canaries") ? "skip" : d ? "todo" : "done", detail: clean((d ?? c("privacy.canaries"))?.detail ?? "after pmx init"), required: true, ...(d ? { do: "pmx init (add your company's email domains)", who: "you" as const, how: "terminal" as const, fix: placeFix("Open Who counts as a customer", "rule:domains", "Add your company's email domains in Settings, under Who counts as a customer.") } : {}) });
    })(),
    i.memoryFilled === null ? step({ id: "setup.memory", title: "Team memory describes your product", status: "skip", detail: "after pmx init", required: false })
      : step({ id: "setup.memory", title: "Team memory describes your product", status: i.memoryFilled ? "done" : "warn", required: false,
        detail: i.memoryFilled ? "memory/product.md has your product's context, so agents draft with it" : "memory/product.md is still the empty template, so agents draft without your product's context",
        ...(i.memoryFilled ? {} : { do: "Fill in memory/product.md in your team repo (what you sell, to whom, the words you use) and commit it. Claude can help.", who: "you" as const, how: "claude" as const,
          fix: claudeFix("/pmx-setup", "In the Claude app, type /pmx-setup and ask Claude to help you describe your product in your team memory.") }) }),
    ...["home.private", "secrets.not-in-config"].map((id) => bad(id)).filter((x): x is DoctorCheck => !!x)
      .map((x) => step({ id: `setup.${x.id}`, title: "PMX's private files stay private", status: "todo", detail: clean(x.detail), do: "Follow the fix in the detail, then pmx checklist", who: "you", how: "terminal", required: true,
        fix: x.id === "home.private" ? pmxFix("Make them private", "PMX makes its own folders private to you again.") : SETUP_FIX })),
  ];

  // ---- The background job (#9: a Mac asleep runs nothing)
  const lastTick = i.state.lastTick;
  const gap = lastTick && i.now.getTime() - Date.parse(lastTick.at) > TICK_GAP_MS;
  const recent = (i.state.tickGaps ?? []).filter((g) => i.now.getTime() - Date.parse(g.to) < 86400000).at(-1);
  const loaded = c("schedule.launchd");
  const AWAKE = personFix("Keep this Mac awake during work hours: on a laptop, keep it plugged in and turn on Prevent automatic sleeping when the display is off, in System Settings → Battery → Options.");
  const job: Step[] = [
    !p ? step({ id: "job.installed", title: "The background job runs PMX every 30 minutes", status: "skip", detail: "after pmx init", required: true })
      : fromCheck("schedule.launchd", "The background job runs PMX every 30 minutes", { as: "job.installed", required: true, do: "pmx init, and say yes to the background job", who: "you", how: "terminal",
        fix: pmxFix("Turn on automatic runs", "PMX registers its background job on this Mac, so it checks every 30 minutes on its own. It asks you on the Mac first.", true) }),
    (() => {
      const x = bad("schedule.job-paths") ?? bad("schedule.job-claude");
      if (!loaded?.ok) return step({ id: "job.paths", title: "The job finds Node and Claude Code", status: "skip", detail: "after the job is registered", required: true });
      return step({ id: "job.paths", title: "The job finds Node and Claude Code", status: x ? "todo" : "done", detail: x ? clean(x.detail) : "the job's Node and Claude Code paths exist", required: true, ...(x ? { do: RUN_FIX, who: "you" as const, how: "terminal" as const, afterUpdate: updatedHere, fix: pmxFix("Refresh the background job", "PMX rewrites its background job with today's Node and Claude Code. It asks you on the Mac first.", true) } : {}) });
    })(),
    (() => {
      if (!loaded?.ok) return step({ id: "job.passes", title: "The job is running", status: "skip", detail: "after the job is registered", required: true });
      if (!lastTick) return step({ id: "job.passes", title: "The job is running", status: "todo", detail: "registered, but it hasn't run yet. Its first run is within 30 minutes while the Mac is awake.", required: true, do: "Wait up to 30 minutes, then pmx checklist", who: "you", how: "terminal", fix: pmxFix("Run now", "The first run is within 30 minutes while this Mac is awake, or PMX runs now.") });
      const failing = bad("schedule.tick");
      if (failing) return step({ id: "job.passes", title: "The job is running", status: "warn", detail: clean(failing.detail), required: true, do: "Read ~/.pmx/logs/tick.log, fix what it says, then pmx checklist", who: "you", how: "terminal", fix: claudeFix("/pmx-setup", "In the Claude app, type /pmx-setup: Claude reads the background job's log with you and fixes what it says.") });
      if (gap) return step({ id: "job.passes", title: "The job is running", status: "warn", required: true,
        detail: `no run since ${hm(lastTick.at)} (${ago(i.now, lastTick.at)} ago). PMX, its Claude tasks and the Linear sync run only while this Mac is awake, so it was probably asleep or off.`,
        do: "Wake the Mac and keep it awake during work hours (on a laptop, keep it plugged in and turn on System Settings → Battery → Options → Prevent automatic sleeping when the display is off)", who: "you", how: "app", fix: AWAKE });
      return step({ id: "job.passes", title: "The job is running", status: recent ? "warn" : "done", required: true,
        detail: recent ? `last run ${hm(lastTick.at)}; nothing ran from ${hm(recent.from)} to ${hm(recent.to)} (${ago(new Date(recent.to), recent.from)}), while this Mac was asleep or off` : `last run ${hm(lastTick.at)}, every 30 minutes while this Mac is awake`,
        ...(recent ? { do: "Keep the Mac awake during work hours (on a laptop, plugged in, with System Settings → Battery → Options → Prevent automatic sleeping when the display is off)", who: "you" as const, how: "app" as const, fix: AWAKE } : {}) });
    })(),
    fromCheck("cli.auto-update", "Updates arrive by themselves", { required: false, do: "pmx update", who: "you", how: "terminal", skip: "your team installs updates by hand (pmx update)", fix: UPDATE_FIX }),
  ];

  // ---- The Claude app
  const tasks = i.checks.filter((x) => /^claude\.task\.[^.]+$/.test(x.id));
  const taskRan = i.checks.filter((x) => /^claude\.task\..+\.ran$/.test(x.id) && !x.ok);
  const outdated = tasks.filter((x) => !x.ok && /older prompt/.test(x.detail));
  const missing = tasks.filter((x) => !x.ok && !/older prompt/.test(x.detail));
  const old = bad("flow.mcp-old"), mcp = bad("flow.mcp");
  const flowPage = bad("flow.page"), board = c("claude.board");
  const claude: Step[] = !i.claude || !p ? [step({ id: "claude.app", title: "The Claude app runs PMX's tasks", status: "skip", detail: !p ? "after pmx init" : "no Claude app or Claude Code home on this Mac", required: false })] : [
    step({ id: "claude.setup", title: "Claude can guide you through PMX (/pmx-setup)", status: i.setupSkill === "current" || i.setupSkill === "yours" ? "done" : "warn", required: false,
      detail: { current: "/pmx-setup is in the Claude app", yours: "/pmx-setup is your own copy, so PMX leaves it alone", outdated: "/pmx-setup is from an older pmx", missing: "/pmx-setup isn't in the Claude app yet" }[i.setupSkill],
      ...(i.setupSkill === "missing" || i.setupSkill === "outdated" ? { do: "pmx checklist --install-skill, then quit and reopen the Claude app", who: "you" as const, how: "terminal" as const, afterUpdate: i.setupSkill === "outdated",
        fix: pmxFix(i.setupSkill === "missing" ? "Add /pmx-setup" : "Update /pmx-setup", "PMX adds its guide to the Claude app's commands, so /pmx-setup walks you through PMX.") } : {}) }),
    fromCheck("claude.allow", "PMX's scheduled tasks may run PMX without asking", { required: true, do: "pmx schedule --allow", who: "you", how: "terminal",
      fix: pmxFix("Let PMX's tasks run", "PMX adds always-allow rules for its own command and folder to your Claude settings, so scheduled runs don't stop to ask. It asks you on the Mac first.", true) }),
    tasks.length === 0 ? step({ id: "claude.tasks", title: "The Claude app runs PMX's scheduled tasks", status: "skip", detail: "PMX needs no scheduled tasks with these settings", required: false })
      : step({
        id: "claude.tasks", title: "The Claude app runs PMX's scheduled tasks", required: true,
        status: missing.length || outdated.length ? "todo" : taskRan.length ? "warn" : "done",
        detail: missing.length || outdated.length ? [missing.length ? `missing: ${missing.map((x) => x.detail.match(/"([^"]+)"/)?.[1] ?? x.id).join(", ")}` : "", outdated.length ? `from an older pmx: ${outdated.map((x) => x.detail.match(/"([^"]+)"/)?.[1] ?? x.id).join(", ")}` : ""].filter(Boolean).join("; ")
          : taskRan.length ? taskRan.map((x) => clean(x.detail)).join("; ") : `${plural(tasks.length, "task")} set up and running`,
        ...(missing.length || outdated.length ? { do: "In the Claude app: Code tab, a new session with auto mode off, type /pmx-schedule", who: "claude" as const, how: "claude" as const, afterUpdate: outdated.length > 0,
          // CLAUDE-6: from 0.36.0 the hours are PMX's setting, so this update's /pmx-schedule is the last one an hours change needs.
          fix: claudeFix("/pmx-schedule", outdated.length && since(HOURS_SINCE)
            ? "In the Claude app, type /pmx-schedule once more, in a Code tab session with auto mode off. From this update your working hours are a PMX setting, so changing them never needs it again."
            : "In the Claude app, type /pmx-schedule in a Code tab session with auto mode off: Claude sets up PMX's tasks.") }
          : taskRan.length ? { do: "In the Claude app, open Code → Scheduled, open the task's last run and choose Always allow for what it asks", who: "you" as const, how: "app" as const,
            fix: personFix("In the Claude app, open Code → Scheduled, open the task's last run and choose Always allow for what it asks.") } : {}),
      }),
    old ? step({ id: "claude.mcp", title: "The Claude app reaches this PMX", status: "warn", detail: clean(old.detail), required: false, do: "Quit the Claude app completely (⌘Q) and open it again", who: "you", how: "app", afterUpdate: since("0.25.1") || updatedHere,
      fix: personFix("Quit the Claude app completely (⌘Q, not just its window) and open it again.") })
      : mcp ? step({ id: "claude.mcp", title: "The Claude app reaches this PMX", status: "warn", detail: clean(mcp.detail), required: false, do: "pmx mcp --install, then quit the Claude app (⌘Q) and open it again", who: "you", how: "terminal",
        fix: pmxFix("Repair the connection", "PMX points the Claude app at this PMX; then quit the Claude app (⌘Q) and open it again.", i.mcpRegistered === false) })
        : step({ id: "claude.mcp", title: "The Claude app reaches this PMX", status: c("flow.mcp") ? "done" : "skip", detail: c("flow.mcp") ? clean(c("flow.mcp")!.detail) : "not set up: only PMX's page in Claude needs it", required: false }),
    // FLOW-8: a page published with 0.36.0 or later updates itself; one from before needs this update's /pmx-flow once.
    flowPage ? step({ id: "claude.page", title: "PMX's page in Claude is current", status: "warn", detail: clean(flowPage.detail), required: false, do: "Type /pmx-flow in the Claude app", who: "claude", how: "claude", afterUpdate: true,
      fix: claudeFix("/pmx-flow", selfUpdateHere
        ? "In the Claude app, type /pmx-flow once more: from this update on, the page updates itself next time you open it after PMX updates."
        : "In the Claude app, type /pmx-flow: Claude publishes the page again, and it keeps its link.") })
      : step({ id: "claude.page", title: "PMX's page in Claude is current", status: p.flow?.url ? "done" : "todo", required: false,
        detail: !p.flow?.url ? "not published yet. PMX's page shows what's waiting for you, what ran and where your data went."
          : p.flow.version && p.flow.version !== i.version && selfUpdating(p.flow.version) ? `published with pmx ${p.flow.version}; it updates itself to pmx ${i.version} next time you open it`
          : `published with pmx ${p.flow.version ?? "?"} on ${day(p.flow.publishedAt ?? i.now.toISOString())}${selfUpdating(p.flow.version) ? "; it updates itself after each PMX update" : ""}`,
        ...(p.flow?.url ? {} : { do: "pmx flow --install-skill, then type /pmx-flow in the Claude app (or open it on this Mac with pmx open)", who: "you" as const, how: "terminal" as const,
          fix: i.appSkills && !i.appSkills.flow ? pmxFix("Add /pmx-flow", "PMX adds /pmx-flow to the Claude app's commands. Then type /pmx-flow there to publish this page.")
            : claudeFix("/pmx-flow", "In the Claude app, type /pmx-flow: Claude publishes PMX's page there, and from then on it updates itself.") }) }),
    // The team board reads Linear only, so it needs /pmx-board again only when its page changes in a PMX update.
    !board ? step({ id: "claude.board", title: "Your team board is in Claude", status: "skip", detail: "only for teams on Linear", required: false })
      : step({ id: "claude.board", title: "Your team board is in Claude", status: board.ok ? "done" : "warn", detail: clean(board.detail), required: false, ...(board.ok ? {} : { do: "Type /pmx-board in the Claude app", who: "claude" as const, how: "claude" as const, afterUpdate: /older pmx|changed/.test(board.detail),
        fix: i.appSkills && !i.appSkills.board ? pmxFix("Add /pmx-board", "PMX adds /pmx-board to the Claude app's commands. Then type /pmx-board there to publish your team's board.")
          : claudeFix("/pmx-board", "In the Claude app, type /pmx-board: Claude publishes your team's board with the same link. It's needed again only when an update changes the board's page.") }) }),
  ];

  // ---- Linear
  const linearOn = team?.tracker.kind === "linear";
  const legacyWeekdays = !!i.linearCron && /\s1-5$/.test(i.linearCron.trim());
  const workHours = (p?.taskHours ?? "weekdays") === "weekdays";
  const relay = bad("linear.relay") ?? c("linear.relay");
  const linear: Step[] = !linearOn ? [step({ id: "linear.connected", title: "PMX reaches your team's Linear", status: "skip", detail: "your team doesn't use Linear", required: false })] : [
    c("secrets.linear")?.ok ? step({ id: "linear.connected", title: "PMX reaches your team's Linear", status: "done", detail: clean(c("secrets.linear")!.detail), required: true })
      // F16: before this Mac's first sync, the step waits for it; it isn't failing.
      : relay && /not synced yet/.test(relay.detail) ? step({ id: "linear.connected", title: "PMX reaches your team's Linear", status: "todo", required: true,
        detail: "waiting for this Mac's first Linear sync. PMX's Linear sync in the Claude app runs at the top of each hour; this Mac's first one hasn't run yet, so PMX can't see your team's tasks here until it does",
        do: "Wait for the next hour; Health → Running on PMX's page shows when the Linear sync ran. If the Claude app has no Linear sync task, type /pmx-schedule there", who: "claude" as const, how: "app" as const,
        page: "Waiting for this Mac's first Linear sync, at the top of the hour. Health → Running shows when it ran.",
        fix: placeFix("Open Running", "tab:health/running", "Waiting for this Mac's first Linear sync: it runs at the top of each hour in the Claude app. Running shows when it ran.") })
      : relay ? step({ id: "linear.connected", title: "PMX reaches your team's Linear", status: relay.ok ? "done" : "warn", detail: clean(relay.detail), required: true, ...(relay.ok ? {} : { do: "Check the Linear sync task: in the Claude app, Code → Scheduled. If it's missing, type /pmx-schedule.", who: "you" as const, how: "app" as const,
        fix: claudeFix("/pmx-schedule", "Check the Linear sync task in the Claude app, under Code → Scheduled. If it's missing, type /pmx-schedule there.") }) })
        : step({ id: "linear.connected", title: "PMX reaches your team's Linear", status: "todo", detail: "no Linear sync has run yet", required: true, do: "Type /pmx-schedule in the Claude app; it creates the Linear sync task", who: "claude", how: "claude",
          fix: claudeFix("/pmx-schedule", "In the Claude app, type /pmx-schedule: Claude creates the Linear sync task.") }),
    // CLAUDE-6: from 0.36.0 the hours are PMX's own setting. A task from before still runs on weekdays only, until
    // this update's /pmx-schedule; after that an hours change is one click here.
    i.linearCron === null ? step({ id: "linear.hours", title: "Linear syncs whenever PMX runs", status: "skip", detail: "PMX writes to Linear directly", required: false })
      : legacyWeekdays ? step({ id: "linear.hours", title: "Linear syncs whenever PMX runs", status: "warn", required: false,
        detail: "the Linear sync task in the Claude app still runs only on weekdays, 8:00 to 18:00, so what you approve at night or on a weekend waits, and so do tasks a teammate makes Ready",
        do: "Type /pmx-schedule in the Claude app once more; from then on your hours are a PMX setting (pmx schedule --hours)", who: "claude", how: "claude", afterUpdate: since(HOURS_SINCE) || since("0.35.0"),
        fix: claudeFix("/pmx-schedule", "In the Claude app, type /pmx-schedule once more. After that your working hours are a PMX setting, and changing them never needs it again.") })
      : step({ id: "linear.hours", title: "Linear syncs whenever PMX runs", status: workHours ? "warn" : "done", required: false,
        detail: workHours ? "Linear syncs in your working hours only, weekdays 8:00 to 18:00, so what you approve at night or on a weekend waits, and so do tasks a teammate makes Ready" : "Linear syncs every hour, every day",
        ...(workHours ? { do: "pmx schedule --hours always", who: "you" as const, how: "page" as const,
          fix: pmxFix("Sync whenever PMX runs", "PMX lets the Linear sync work every hour, every day. Nothing changes in the Claude app.") } : {}) }),
  ];

  // ---- Your work now (#11 approval and Ready are two steps; #14 practice mode)
  const lastCollect = i.state.collectReports.at(-1);
  const never = bad("synth.never");
  const startNow = !team || startsNow(team);
  const work: Step[] = !p ? [] : [
    step({ id: "work.meetings", title: "Meetings reach PMX", status: lastCollect ? (never ? "warn" : "done") : "todo", required: true,
      detail: lastCollect ? `last collection ${day(lastCollect.at)} ${hm(lastCollect.at)}: ${lastCollect.saved} saved${never ? `; ${clean(never.detail)}` : ""}` : "no meeting collected yet",
      ...(lastCollect ? {} : { do: "Type /pmx-schedule in the Claude app; its collection task saves new meetings at 12:30 and 17:30 on weekdays", who: "claude" as const, how: "claude" as const,
        fix: claudeFix("/pmx-schedule", "In the Claude app, type /pmx-schedule: Claude creates the task that collects your meetings at 12:30 and 17:30.") }) }),
    channelStep(team, p, step),
    i.proposals === null ? step({ id: "work.approve", title: "New tasks wait for your approval", status: "skip", detail: "PMX can't read the tasks waiting for you here", required: false })
      : step({ id: "work.approve", title: "New tasks wait for your approval", status: i.proposals ? "todo" : "done", required: false,
        detail: i.proposals ? `${plural(i.proposals, "new task")} wait${i.proposals === 1 ? "s" : ""} for you. Nothing reaches Linear until you approve it.` : "nothing waits for your approval",
        ...(i.proposals ? startNow
          ? { do: "Start, approve for later or drop them in PMX's page (Needs you), or with pmx proposals", who: "you" as const, how: "page" as const, page: "Start now, Later or Drop each one in Needs you.", fix: placeFix("Open Needs you", "tab:needs") }
          : { do: "Approve or drop them in PMX's page (Needs you), or with pmx proposals", who: "you" as const, how: "page" as const, page: "Approve or drop them in Needs you.", fix: placeFix("Open Needs you", "tab:needs") } : {}) }),
    // APPROVE-3: with Start now on, the PM's own approval makes a task Ready, so there's no second gate to wait for.
    !i.tasks ? step({ id: "work.ready", title: startNow ? "Start now makes tasks Ready for agents" : "A teammate makes tasks Ready for agents", status: "skip", detail: linearOn ? "PMX counts these only from its own copy of Linear" : "no tracker", required: false })
      : startNow ? step({ id: "work.ready", title: "Start now makes tasks Ready for agents", required: false, status: "done",
        detail: `${i.tasks.ready} Ready for agents, ${i.tasks.pool} in the backlog${i.tasks.blocked ? `, ${i.tasks.blocked} Blocked` : ""}. Start now on a new task makes it Ready at once (Todo in Linear); Later puts it in the backlog, where it waits until someone moves it to Todo in Linear.` })
      : step({ id: "work.ready", title: "A teammate makes tasks Ready for agents", required: false,
        status: i.tasks.ready ? "done" : i.tasks.pool ? "todo" : "done",
        detail: `${i.tasks.ready} Ready for agents, ${i.tasks.pool} in the backlog${i.tasks.blocked ? `, ${i.tasks.blocked} Blocked` : ""}. Approving sends a task to the backlog; an agent takes it only after a teammate moves it to Todo in Linear.`,
        ...(!i.tasks.ready && i.tasks.pool ? { do: "In Linear, move the backlog's tasks worth an agent's time to Todo (or to Ready on the team board, /pmx-board)", who: "teammate" as const, how: "linear" as const,
          fix: personFix("A teammate moves the backlog's tasks worth an agent's time to Todo in Linear, or to Ready on your team's board.", team?.board?.url ?? p.board?.url ?? undefined) } : {}) }),
    step({ id: "work.practice", title: "Agents run tasks for real", status: i.practiceUntil ? "warn" : "done", required: false,
      detail: i.practiceUntil ? `practice mode until ${day(i.practiceUntil)}: for its first week your agent says which task it would take, without running it` : "your agent runs Ready tasks that fit the budget",
      ...(i.practiceUntil ? { do: "Wait, or run one now with pmx pull --live", who: "you" as const, how: "terminal" as const, page: `Real runs start ${day(i.practiceUntil)}.`,
        fix: personFix(`Real runs start ${day(i.practiceUntil)}. Until then your agent says which task it would take.`) } : {}) }),
    (() => {
      const ks = bad("killswitch"), money = bad("budget");
      if (ks) return step({ id: "work.agents", title: "Agents can take work", status: "todo", detail: clean(ks.detail), required: true, do: "When it's safe, delete pmx.stop from your team repo's main branch (and from your own checkout)", who: "team-lead", how: "terminal",
        fix: personFix("Your team lead turns the emergency stop off when it's safe.") });
      if (money) return step({ id: "work.agents", title: "Agents can take work", status: "warn", detail: clean(money.detail), required: false, do: "Raise your daily cap in PMX's page (Settings), or wait for tomorrow's budget", who: "you", how: "page",
        fix: placeFix("Open Budget and limits", "rule:budget", "Raise your daily limit in Settings, under Budget and limits, or wait for tomorrow's budget.") });
      const blocked = i.tasks?.blocked ?? 0;
      return step({ id: "work.agents", title: "Agents can take work", status: blocked ? "warn" : "done", required: false,
        detail: `${i.lastRun ? `last run ${i.lastRun.taskId} ${day(i.lastRun.ts)} ${hm(i.lastRun.ts)}: ${i.lastRun.outcome === "ok" ? "drafted" : i.lastRun.outcome}` : "no agent run yet"}${blocked ? `; ${plural(blocked, "task")} Blocked after failing twice in a row` : ""}`,
        ...(blocked ? { do: "In PMX's page (Needs you, Stopped after failed runs), try each one again, edit it, or drop it (or pmx review --stopped)", who: "you" as const, how: "page" as const, page: "In Needs you, under Stopped after failed runs, try each one again, edit it or drop it.", fix: placeFix("Open Needs you", "tab:needs") } : {}) });
    })(),
    ...i.extra.map(step),
  ];

  // ---- PMX and PMX Engine. INSTALL-4: Engine is the team's product lead's tool, and the team names its product lead in
  // pmx.config.json. Without Engine, only the named lead has a step to do; for everyone else it never applies.
  const lead = isProductLead(team, p);
  const engine: Step[] = [
    !i.engine ? (
      !team || !p ? step({ id: "engine.installed", title: "PMX Engine", status: "skip", detail: "after pmx init", required: false })
        : !team.productLead ? step({ id: "engine.installed", title: "PMX Engine", status: "skip", detail: "Your team hasn't named its product lead.", required: false })
        : lead ? step({ id: "engine.installed", title: "Install PMX Engine", status: "todo", required: false,
          detail: "Your team names you its product lead, and PMX Engine, the product lead's tool, isn't on this Mac yet.",
          do: "pmx install --engine", who: "you", how: "terminal",
          fix: pmxFix("Install PMX Engine", "PMX installs PMX Engine on this Mac, where PMX is installed. It asks you on the Mac first.", true) })
        : step({ id: "engine.installed", title: "PMX Engine", status: "skip", detail: "PMX Engine is your product lead's tool.", required: false })
    )
      // CLI-6: found, but it didn't answer, which isn't the same as not being there.
      : "problem" in i.engine ? step({ id: "engine.installed", title: "PMX Engine", status: "warn", required: false,
        detail: `PMX Engine is installed at ${i.engine.problem.path} but didn't start: ${i.engine.problem.reason}`,
        do: "In Terminal, run pmxe --version to see why; reinstalling it (pmx install --engine) usually fixes it", who: "you", how: "terminal",
        fix: personFix("PMX Engine is installed but didn't start; whoever installed it reinstalls it, which usually fixes it.") })
      // SETUP-3: Engine's own steps, and its next one, follow PMX's sections live; here PMX says only that it's there.
      : step({ id: "engine.installed", title: "PMX Engine", status: "done", required: false,
        detail: i.engine.checklist ? `PMX Engine ${i.engine.version} is on this Mac; its own steps follow PMX's` : `PMX Engine ${i.engine.version}, too old to list its own steps here` }),
    !team ? step({ id: "engine.link", title: "PMX links to the PMs' page in PMX Engine", status: "skip", detail: "after pmx init", required: false })
      : step({ id: "engine.link", title: "PMX links to the PMs' page in PMX Engine", status: team.roadmap?.url ? "done" : i.engine ? "warn" : "skip", required: false,
        detail: team.roadmap?.url ? `linked: ${team.roadmap.url}` : "no link to the PMs' page in pmx.config.json",
        ...(team.roadmap?.url || !i.engine ? {} : { do: "Team lead: add \"roadmap\": { \"url\": \"<the PMs' page link>\" } to pmx.config.json in a pull request", who: "team-lead" as const, how: "terminal" as const,
          fix: personFix("Your team lead adds the link to the PMs' page to your team's settings.") }) }),
  ];

  // ---- Updates (UPGRADE-1)
  const applied = rec ? AUTO_STEPS.filter((s) => applies(s, rec.from, i.version)).map((s) => ({ s, a: rec.applied[s.since === null ? `${s.id}@${i.version}` : s.id] })) : [];
  const update: Step[] = [
    step({ id: "update.version", title: "This Mac is on the version it last ran", status: "done", required: false,
      detail: !rec ? `pmx ${i.version}` : updatedHere ? `pmx ${i.version}, updated from ${rec.from ?? "an older pmx"} ${rec.at ? `on ${day(rec.at)}` : ""}`.trim() : `pmx ${i.version}${rec.at ? ` since ${day(rec.at)}` : ""}` }),
    ...applied.map(({ s, a }) => step({ id: `update.${s.id}`, title: s.title, status: a ? "done" : "warn", required: false,
      detail: a ? `${a.did} (${day(a.at)} ${hm(a.at)})` : s.interactiveOnly ? "waits for the next pmx command you run (the background job doesn't reload itself)" : "PMX will do it on its next run",
      ...(a ? {} : { do: RUN_FIX, who: "you" as const, how: "terminal" as const, afterUpdate: true,
        fix: pmxFix("Do it now", s.interactiveOnly ? "PMX does it now. It asks you on the Mac first." : "PMX does it now instead of on its next run.", !!s.interactiveOnly) }) })),
  ];

  const sections: Section[] = [
    { id: "mac", title: "This Mac", steps: mac },
    { id: "setup", title: "Your PMX setup", steps: setup },
    { id: "job", title: "Background job", steps: job },
    { id: "claude", title: "Claude app", steps: claude },
    { id: "linear", title: "Linear", steps: linear },
    { id: "work", title: "Your work now", steps: work },
    { id: "engine", title: "PMX and PMX Engine", steps: engine },
    { id: "update", title: "Updates", steps: update },
  ].filter((s) => s.steps.length);
  const all = sections.flatMap((s) => s.steps);
  const open = (s: Step) => s.status === "todo" || s.status === "warn";
  const next = all.find((s) => s.required && open(s)) ?? all.find((s) => s.status === "todo") ?? all.find((s) => s.status === "warn") ?? null;
  const counts = { done: 0, todo: 0, warn: 0, skip: 0 } as Record<StepStatus, number>;
  for (const s of all) counts[s.status]++;
  return {
    format: 1, tool: "pmx", version: i.version, at: i.now.toISOString(),
    where: whereYouStand(i, all), next, sections, counts,
    upgrade: rec ? {
      from: rec.from, to: i.version, at: rec.at,
      applied: applied.filter((x) => x.a).map(({ s, a }) => ({ id: s.id, title: s.title, at: a!.at, did: a!.did })),
      pending: all.filter((s) => s.afterUpdate && open(s)),
    } : null,
  };
}

/**
 * INPUT-3: the team's approved channels are read only on its synthesis Mac (INPUT-1), so with none chosen no channel is
 * ever read, and nothing said so. Choosing it is a team setting: the page's Sources sends it to the team for review.
 */
function channelStep(team: TeamConfig | null, p: PersonalConfig, step: (s: Step) => Step): Step {
  const channels = team ? channelInputs(team) : [];
  const places = channels.reduce((n, c) => n + c.places.length, 0);
  const title = "A Mac reads your team's channels";
  if (!team || !places) return step({ id: "work.channels", title, status: "skip", detail: "your team hasn't approved any channels", required: false });
  const where = channels.map((c) => c.connector).join(", ");
  if (!team.synthesizer) return step({ id: "work.channels", title, status: "todo", required: false,
    detail: `${NO_SYNTH_MAC}. Your team approved ${plural(places, "place")} in ${where}, but only its synthesis Mac reads them, and it hasn't chosen one, so none is read`,
    do: "Choose a synthesis Mac in PMX's page: Settings → Sources → Who reads them. It goes to your team for review, like any team setting", who: "you", how: "page",
    page: "Choose a synthesis Mac in Settings, under Sources. It goes to your team for review.",
    fix: placeFix("Open Sources", "tab:health/settings/sources", "Choose a synthesis Mac in Settings, under Sources: that Mac reads your team's channels and suggests tasks for everyone. It goes to your team for review.") });
  const here = collectsChannels(team, p, agentHandle(p));
  return step({ id: "work.channels", title, status: "done", required: false,
    detail: `your team's ${plural(places, "approved place")} in ${where} ${places === 1 ? "is" : "are"} read on ${here ? "this Mac" : `${team.synthesizer}'s Mac`}, your team's synthesis Mac` });
}

function whereYouStand(i: ChecklistInputs, all: Step[]): string {
  const req = all.filter((s) => s.required && (s.status === "todo" || s.status === "warn"));
  if (!i.personal) return `pmx ${i.version} is installed but not set up on this Mac yet: setup asks a few questions only you can answer, then registers the background job.`;
  if (req.length) return `PMX is set up, but ${plural(req.length, "required step")} ${req.length === 1 ? "is" : "are"} left before it can do its job: ${req.map((s) => s.title).join("; ")}.`;
  const work = [
    i.proposals ? `${plural(i.proposals, "new task")} wait${i.proposals === 1 ? "s" : ""} for your approval` : null,
    i.tasks && !i.tasks.ready && i.tasks.pool ? `${plural(i.tasks.pool, "task")} in the backlog, none Ready for agents` : i.tasks?.ready ? `${i.tasks.ready} Ready for agents` : null,
    i.practiceUntil ? `agents are in practice mode until ${day(i.practiceUntil)}` : null,
  ].filter(Boolean);
  const optional = all.filter((s) => !s.required && s.status === "warn").length;
  return `PMX is installed and running on this Mac.${work.length ? ` ${work.join("; ")}.` : ""}${optional ? ` ${plural(optional, "optional step")} left.` : ""}`.replace(/\.\./g, ".");
}

// ---- History: the checklist as each step changed, so it follows what actually happened on this Mac.

export interface ChecklistHistory {
  format: 1;
  at: string;
  steps: Record<string, { status: StepStatus; since: string | null; changedAt: string }>;
  log: { at: string; id: string; from: StepStatus | null; to: StepStatus }[];
  /** The last checklist worked out, for PMX's page and Claude (read without running any check). */
  last: Checklist | null;
}

export const checklistFile = () => join(paths.home(), "checklist.json");

export async function readHistory(): Promise<ChecklistHistory | null> {
  const h = await readJson<ChecklistHistory>(checklistFile()).catch(() => null);
  return h?.format === 1 ? h : null;
}

/**
 * Records each step's change and fills `since` (when it was first seen done). On a Mac with no history yet, steps
 * already done take their date from what PMX recorded when they happened, where it knows (`evidence`).
 */
/** Steps recorded under another ID before: until 0.36.0 the background job's step had its doctor check's ID. */
const FORMERLY: Record<string, string> = { "job.installed": "schedule.launchd" };

export async function recordChecklist(cl: Checklist, evidence: Record<string, string | null | undefined> = {}): Promise<Checklist> {
  const h: ChecklistHistory = (await readHistory()) ?? { format: 1, at: cl.at, steps: {}, log: [], last: null };
  const fresh = !Object.keys(h.steps).length;
  for (const [now, before] of Object.entries(FORMERLY)) if (!h.steps[now] && h.steps[before]) { h.steps[now] = h.steps[before]!; delete h.steps[before]; }
  for (const s of cl.sections.flatMap((x) => x.steps)) {
    const was = h.steps[s.id];
    if (!was || was.status !== s.status) {
      h.log.push({ at: cl.at, id: s.id, from: was?.status ?? null, to: s.status });
      h.steps[s.id] = { status: s.status, since: was?.since ?? (s.status === "done" ? (fresh ? evidence[s.id] ?? cl.at : cl.at) : null), changedAt: cl.at };
    }
    s.since = h.steps[s.id]!.since;
  }
  h.log = h.log.slice(-200);
  h.at = cl.at;
  h.last = cl;
  await writeJson(checklistFile(), h, 0o600);
  return cl;
}

// ---- Text, for Terminal and for Claude reading along

const MARK: Record<StepStatus, string> = { done: "✔", todo: "✘", warn: "!", skip: "–" };
const WHO: Record<Who, string> = { you: "you", claude: "Claude, in the Claude app", teammate: "a teammate", "team-lead": "your team lead" };

export function formatChecklist(cl: Checklist, o: { all?: boolean } = {}): string {
  const lines = [`PMX ${cl.version} on this Mac · checked ${new Date(cl.at).toLocaleString()}`, "", `Where you stand: ${cl.where}`];
  for (const sec of cl.sections) {
    // "Your work now" shows what's off too (the brain, practice mode): what runs is part of where you stand.
    const shown = o.all || sec.id === "work" ? sec.steps : sec.steps.filter((s) => s.status !== "skip");
    if (!shown.length) continue;
    lines.push("", sec.title);
    for (const s of shown) {
      lines.push(`  ${MARK[s.status]} ${s.title}: ${s.detail}`);
      if (s.do && (s.status === "todo" || s.status === "warn")) lines.push(`      → ${s.do}${s.who ? ` (${WHO[s.who]})` : ""}`);
    }
  }
  if (cl.upgrade?.pending.length) lines.push("", `Still to do after updating${cl.upgrade.from ? ` from ${cl.upgrade.from}` : ""}:`, ...cl.upgrade.pending.map((s) => `  ✘ ${s.title}: ${s.do ?? s.detail}`));
  lines.push("", cl.next ? `Next: ${cl.next.title}. ${cl.next.do ?? ""}${cl.next.who ? ` (${WHO[cl.next.who]})` : ""}`.trim() : "Nothing left to do.");
  return lines.join("\n");
}

// ---- For PMX's page: the same checklist in words the page may show (no terminal commands, BOARD rule)

export interface SetupView {
  at: string;
  where: string;
  /**
   * `required` and `who` from 0.36.0: the page's Needs you shows the next step only when PMX can't do its job without it.
   * `id` and `fix` from 0.36.0 too (SETUP-2): what the page offers for it.
   */
  next: { id?: string; title: string; page: string; required?: boolean; who?: Who | null; fix?: StepFix | null } | null;
  counts: Record<StepStatus, number>;
  sections: { id: string; title: string; steps: { id: string; title: string; status: StepStatus; detail: string; page: string | null; fix?: StepFix | null }[] }[];
}

/** Drops each clause that names a pmx command: the page points to /pmx-setup for those instead. */
export function pageWords(t: string): string {
  return t
    .replace(/\s*[(:;,—-]?\s*(?:[Rr]un|[Tt]ry|with|then|use|see|or)?\s*`?\bpmx [a-z][^`;.)]*`?\)?/g, "")
    .replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").replace(/[:;,]\s*$/, "").trim();
}

export function checklistForPage(cl: Checklist | null): SetupView | null {
  if (!cl) return null;
  const open = (s: Step) => s.status === "todo" || s.status === "warn";
  const page = (s: Step) => (s.page && !/\bpmx [a-z]/.test(s.page) ? s.page : PAGE_HINT);
  // SETUP-2: the page's words for a fix never name a pmx command either.
  const fix = (s: Step): StepFix | null => {
    if (!open(s) || !s.fix) return null;
    const words = (t?: string) => (t && !/\bpmx [a-z]/.test(t) ? t : undefined);
    const f = { ...s.fix, text: words(s.fix.text) ?? (s.fix.kind === "person" ? PAGE_HINT : undefined) };
    if (f.text === undefined) delete f.text;
    return f;
  };
  return {
    at: cl.at,
    where: pageWords(cl.where) || "See each step below.",
    next: cl.next ? { id: cl.next.id, title: cl.next.title, page: page(cl.next), required: cl.next.required, who: cl.next.who ?? null, fix: fix(cl.next) } : null,
    counts: cl.counts,
    sections: cl.sections.map((sec) => ({
      id: sec.id, title: sec.title,
      steps: sec.steps.filter((s) => s.status !== "skip" || sec.id === "work").map((s) => ({ id: s.id, title: s.title, status: s.status, detail: pageWords(s.detail), page: open(s) ? page(s) : null, fix: fix(s) })),
    })).filter((sec) => sec.steps.length),
  };
}
