import type { ParseArgsConfig } from "node:util";
import type { Asker } from "../core/ask.js";
import { loadPersonalConfig, loadTeamConfig, savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { budget, usageLine } from "../budget/provider.js";
import { consoleOut, type Ctx } from "../core/context.js";
import { exec } from "../core/exec.js";
import { loginProfile, profileSignedIn } from "../core/claude-bin.js";
import { readJson } from "../core/fsutil.js";
import { effectiveTeam } from "../core/services.js";
import { macKeychain } from "../core/keychain.js";
import { OLD } from "../core/rename.js";
import { capTickLogs, macLaunchd } from "../core/launchd.js";
import { runDigest } from "./digest.js";
import { doctorJson, formatDoctor, refreshProfile, runDoctor } from "./doctor.js";
import { nextSteps, runInit, type InviteFile } from "./init.js";
import { runStatus } from "./status.js";
import { digestStep, recordTick, runTick, type TickStep } from "./tick.js";
import { runUninstall } from "./uninstall.js";
import { VENDORED_CLI, vendorCli, vendorMessage } from "../core/vendor.js";
import { atLeast, compareVersions, currentVersion, isVersion, vendoredVersion } from "../core/version.js";
import { formatNotes, markSeen, markUpdatingFrom, newVersionNotes, notesBetween, RELEASE_NOTES } from "../core/whats-new.js";
import { engineChecklist, engineNotes, engineSource, findPmxe, formatEngineNotes, pmxeCandidates, runEngineUpdate } from "../engine/bridge.js";
import { formatEngineChecklist } from "../flow/strategy.js";
import { installLatestRelease, installTeamVersion, updateEngineToo, type UpdateOutcome } from "../core/update.js";
import { canWrite, runInstall } from "../setup/install.js";
import { homedir } from "node:os";
import { Git } from "../core/git.js";
import { loadState } from "../core/state.js";
import { writeJson } from "../core/fsutil.js";
import { TEAM_CONFIG_FILE } from "../core/paths.js";
import { join } from "node:path";
import { listReceipts, readReceipt } from "../core/receipt.js";
import { packageRoot, skillInventory, teamSkillPath } from "../core/skills.js";
import { claudePresent, installAppSkill, SETUP_SKILL } from "../claude/skill.js";
import { AUTO_STEPS } from "../core/upgrade.js";
import { requeueStep } from "../review/requeue.js";
import { formatChecklist, type Checklist, type Step } from "../setup/checklist.js";
import { gatherChecklist } from "../setup/gather.js";
import { syncOrgSkills, validateOrgSkill } from "../core/org-skills.js";
import { checkChange, describe as describeChange, proposeTeamChanges } from "../flow/actions.js";
import { rememberTeamPr } from "../flow/team-prs.js";
import { enqueueSkillDoc } from "../tracker/relay.js";
import { linearAccess } from "../linear/access.js";
import { readFile } from "node:fs/promises";
import { formatReceipt, formatSkills } from "../explain/format.js";
import { resolveLive } from "../explain/resolve.js";
import { startExplainServer } from "../explain/server.js";
import { evidenceTickStep, pullStep, releaseStep, synthStep, teamCommands } from "./team.js";
import { reviewCommand } from "./review.js";
import { cloudCommands } from "./cloud.js";
import { companyStep, meetingCommands, todoStep } from "./meetings.js";
import { teamSyncStep } from "./team-sync.js";
import { updateStep } from "./autoupdate.js";
import { stalePages } from "../claude/pages.js";
import { afterUpdateNote } from "../mcp/handoff.js";
import { linearCommands } from "./linear.js";
import { flowCommands } from "./flow.js";
import { settingsCommands } from "./settings.js";
import { jobsCommands } from "./jobs.js";
import { loadFlowGraph } from "../flow/graph-load.js";
import { syncAnalytics } from "../cloud/account.js";
import { webGuardHook } from "../run/web-guard.js";

export interface RunArgs {
  values: Record<string, any>;
  positionals: string[];
  ask: Asker;
  ctx: () => Promise<Ctx>;
  cliPath: string;
  /** Whether a person can answer prompts here (stdin is a terminal). Tests set it; absent, commands read process.stdin. */
  tty?: boolean;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(a: RunArgs): Promise<number>;
}

const yes = { yes: { type: "boolean", short: "y" } } as const;

/** Steps `pmx tick` runs, in order. Later milestones add synthesis and pull. */
export const tickSteps: [string, TickStep][] = [
  // The team's repo first (JOB-10), so this Mac picks up merged kinds of work and settings; then its version (COMPAT-6).
  ["team", teamSyncStep],
  ["update", updateStep],
  ["digest", digestStep],
  ["todo", todoStep],
  // D2-8: once after an update, the follow-ups an older PMX left waiting, read again by today's rules.
  ["follow-ups", requeueStep],
  ["release", releaseStep],
  ["synthesize", synthStep],
  ["company", companyStep],
  ["evidence", evidenceTickStep],
  ["pull", pullStep],
  ["events", syncAnalytics],
];

/** Right after `pmx update` installs, prints what's new from the new pmx, so whoever ran it (or Claude Code) sees it. */
async function showNewNotes(version: string): Promise<void> {
  const text = await newVersionNotes(exec, currentVersion()).catch(() => null);
  console.log(text ? `\n${text}` : `\nSee what's new in pmx ${version}: pmx whats-new`);
  // A pmx from before 0.24.1 doesn't say which pages to publish again; this one does, for the version it installed.
  if (!text?.includes("Update your PMX page") && !text?.includes("still running PMX's server")) {
    const personal = await loadPersonalConfig().catch(() => null);
    const note = personal && (await afterUpdateNote(await loadTeamConfig(personal.repoPath).catch(() => null), personal, exec, version));
    if (note) console.log(`\n${note}`);
  }
  if (text) await markSeen(version);
}

/**
 * COMPAT-7: one update. `pmx update` is a command a person runs, so it runs PMX Engine's own updater too, where Engine is
 * installed; the background job never does (it installs the team's PMX only). One sentence says how it went.
 */
async function updateEngine(): Promise<void> {
  const line = await updateEngineToo(() => runEngineUpdate(exec), { interactive: true });
  if (line) console.log(`\n${line}`);
}

/**
 * UPGRADE-1: right after `pmx update` installs, the NEW pmx does what the update needs on this Mac and says what's
 * left, so whoever ran the update (or Claude Code) sees every remaining step for the version this Mac came from.
 */
async function showMigrate(): Promise<void> {
  const prefix = (await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 })).stdout.trim();
  if (!prefix) return;
  const r = await exec(join(prefix, "bin", "pmx"), ["migrate"], { timeoutMs: 180000 });
  console.log(r.code === 0 && r.stdout.trim() ? `\n${r.stdout.trim()}` : "\nRun `pmx checklist` to see what's left after this update.");
}

/**
 * The checklist, worked out now and recorded (SETUP-1). `engine`: PMX Engine's checklist when the caller read it
 * already (SETUP-3: `pmx checklist` shows it after PMX's), so pmxe runs once.
 */
async function checklistNow(ctx: Ctx | null, engine: ReturnType<typeof engineChecklist> = engineChecklist(exec)): Promise<Checklist> {
  let personal: PersonalConfig | null = null;
  let team: TeamConfig | null = null;
  try {
    personal = await loadPersonalConfig();
    team = (await effectiveTeam(await loadTeamConfig(personal.repoPath), personal)).team;
  } catch {}
  return gatherChecklist({
    personal, team, checks: await doctorChecks(), exec, keychain: macKeychain(), now: new Date(), ctx, engine: () => engine,
    extra: checklistExtra ? () => checklistExtra!(ctx) : undefined,
  });
}

/**
 * SETUP-3: one checklist for both tools. PMX's own, then PMX Engine's sections where it's on this Mac, read live
 * (never recorded with PMX's). The JSON keeps PMX's format 1 and gains `engine`: Engine's checklist, without commands.
 */
export function checklistOutput(cl: Checklist, engine: Awaited<ReturnType<typeof engineChecklist>>, o: { json?: boolean; all?: boolean }): string {
  const e = engine && "checklist" in engine ? engine.checklist : null;
  if (o.json) return JSON.stringify(e ? { ...cl, engine: e } : cl, null, 2);
  return `${formatChecklist(cl, { all: o.all })}${e ? `\n\n${formatEngineChecklist(e, { all: o.all })}` : ""}`;
}

/**
 * The same checklist for a context PMX already has (SETUP-2): a fix from PMX's page works it out again after it runs,
 * with that context's launchd, keychain and commands, and records it like the background job's pass does.
 */
export async function checklistFor(ctx: Ctx, engine: ReturnType<typeof engineChecklist> = engineChecklist(ctx.exec)): Promise<Checklist> {
  const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: ctx.keychain, launchd: ctx.launchd, exec: ctx.exec, extra: doctorExtra });
  return gatherChecklist({
    personal: ctx.personal, team: ctx.team, checks, exec: ctx.exec, keychain: ctx.keychain, now: new Date(), ctx, engine: () => engine,
    extra: checklistExtra ? () => checklistExtra!(ctx) : undefined,
  });
}

export const commands: Command[] = [
  {
    name: "init",
    summary: "Set up this Mac: PMX repo, clean profile, skills, keychain, background job",
    usage: "pmx init [--invite pmx-invite.json] [--yes]",
    options: { ...yes, invite: { type: "string" } },
    async run(a) {
      const invite = a.values.invite ? await readJson<InviteFile>(a.values.invite) : null;
      const personal = await runInit({
        ask: a.ask, keychain: macKeychain(), launchd: macLaunchd(), exec, out: consoleOut, now: () => new Date(),
        cliPath: a.cliPath, invite, onInvite: inviteHook,
      });
      const r = formatDoctor(await doctorChecks());
      console.log("\n" + r.text);
      const team = await loadTeamConfig(personal.repoPath).catch(() => null);
      if (team) console.log("\n" + (await nextSteps(team, personal)));
      return 0;
    },
  },
  {
    name: "checklist",
    summary: "Where this Mac stands with PMX: each install, setup and update step, what's done, what's running and what's next",
    usage: "pmx checklist [--json] [--all] [--fix [<step>]] [--install-skill]",
    options: { json: { type: "boolean" }, all: { type: "boolean" }, fix: { type: "boolean" }, "install-skill": { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill(SETUP_SKILL);
        console.error(r === "kept-yours" ? "Kept your own /pmx-setup." : `/pmx-setup ${r === "current" ? "is already" : "is now"} in the Claude app. Quit and reopen the app if it doesn't show up.`);
      }
      // --fix <step>: one step PMX can do itself, from the same allowlist as the button on PMX's page (SETUP-2).
      if (a.values.fix && a.positionals[0]) {
        const ctx = await a.ctx();
        const { runFix } = await import("../setup/fix.js");
        const r = await runFix(a.positionals[0], await checklistFor(ctx), { ctx, cliPath: a.cliPath, confirm: (what) => a.ask.confirm(`PMX will ${what}. Go ahead?`, false) });
        console.error(r.message);
        const engine = engineChecklist(exec);
        const cl = await checklistFor(ctx, engine);
        console.log(checklistOutput(cl, await engine.catch(() => null), { json: a.values.json, all: a.values.all }));
        return r.status < 400 ? 0 : 1;
      }
      if (a.positionals[0]) throw new Error(`pmx checklist takes a step only with --fix, like pmx checklist --fix job.installed.`);
      // --fix: the steps an update does by itself (UPGRADE-1), now, whatever was recorded.
      if (a.values.fix) for (const s of AUTO_STEPS) {
        const did = await s.run({ exec, launchd: macLaunchd(), cliPath: a.cliPath, interactive: true }).catch((e: any) => `couldn't: ${e?.message ?? e}`);
        console.error(`${s.title}: ${did ?? "nothing to do"}`);
      }
      const engine = engineChecklist(exec);
      const cl = await checklistNow(await a.ctx().catch(() => null), engine);
      console.log(checklistOutput(cl, await engine.catch(() => null), { json: a.values.json, all: a.values.all }));
      return 0;
    },
  },
  {
    name: "guide",
    summary: "The guide Claude follows to install, set up, update and check PMX with you, for this version",
    usage: "pmx guide",
    options: {},
    async run() {
      console.log(await readFile(join(packageRoot(), "GUIDE.md"), "utf8"));
      return 0;
    },
  },
  {
    name: "migrate",
    summary: "What the last update did on this Mac and what's still to do (pmx update runs it)",
    usage: "pmx migrate [--json]",
    options: { json: { type: "boolean" } },
    async run(a) {
      // The update steps already ran before this command started (src/cli.ts); this says what they did and what's left.
      const cl = await checklistNow(await a.ctx().catch(() => null));
      const u = cl.upgrade;
      if (a.values.json) {
        console.log(JSON.stringify({ format: 1, from: u?.from ?? null, to: cl.version, at: u?.at ?? null, applied: u?.applied ?? [], pending: u?.pending ?? [], next: cl.next }, null, 2));
        return 0;
      }
      const waiting = cl.sections.find((s) => s.id === "update")?.steps.filter((s) => s.status === "warn") ?? [];
      console.log([
        `pmx ${cl.version}${u?.from && u.from !== cl.version ? `, updated from ${u.from}` : ""}.`,
        u?.applied.length ? `PMX did:\n${u.applied.map((x) => `  ✔ ${x.title}: ${x.did}`).join("\n")}` : "PMX had nothing to change on this Mac.",
        ...(waiting.length ? [`Waiting:\n${waiting.map((s) => `  ! ${s.title}: ${s.detail}`).join("\n")}`] : []),
        u?.pending.length ? `Still to do for this update:\n${u.pending.map((s) => `  ✘ ${s.title}: ${s.do ?? s.detail}`).join("\n")}` : "Nothing else to do for this update.",
        cl.next ? `Next: ${cl.next.title}. ${cl.next.do ?? ""}`.trim() : "",
        "The full list: pmx checklist",
      ].filter(Boolean).join("\n\n"));
      return 0;
    },
  },
  {
    name: "doctor",
    summary: "Green/red checklist, including every clean-profile check",
    usage: "pmx doctor [--json]",
    options: { json: { type: "boolean" } },
    async run(a) {
      const checks = await doctorChecks();
      if (a.values.json) {
        const j = doctorJson(checks);
        console.log(JSON.stringify(j, null, 2));
        return j.ok ? 0 : 1;
      }
      const r = formatDoctor(checks);
      console.log(r.text);
      return r.ok ? 0 : 1;
    },
  },
  {
    name: "claude",
    summary: "PMX's own Claude profile (~/.pmx/claude), which agent runs use: `login` signs it in, separately from your usual Claude sign-in",
    usage: "pmx claude [status] | pmx claude login",
    options: {},
    async run(a) {
      const before = await profileSignedIn(exec);
      if (a.positionals[0] !== "login") {
        console.log(before ? `${before.ok ? "✔" : "✘"} ${before.detail}.` : "PMX can't tell: Claude Code is missing or too old to report its sign-in.");
        return before?.ok === false ? 1 : 0;
      }
      if (before?.ok) console.log(`${before.detail}. Signing in again replaces it.`);
      const code = await loginProfile(exec);
      const after = await profileSignedIn(exec);
      console.log(after?.ok ? `✔ ${after.detail}.` : "PMX's Claude profile still isn't signed in. Run `pmx claude login` again.");
      return code === 0 && after?.ok !== false ? 0 : 1;
    },
  },
  {
    name: "digest",
    summary: "Build this week's digest from your sources and approve it before it's committed",
    usage: "pmx digest [--review] [--stage] [--days 7]",
    options: { review: { type: "boolean" }, stage: { type: "boolean" }, days: { type: "string" } },
    async run(a) {
      const ctx = await a.ctx();
      console.log(await runDigest(ctx, a.ask, { review: a.values.review, stage: a.values.stage, days: a.values.days ? Number(a.values.days) : undefined }));
      return 0;
    },
  },
  {
    name: "status",
    summary: "Show config, kill switch, spend and recent runs",
    options: {},
    async run(a) {
      // BOARD-11: Engine's moves that are yours count in the "Needs you" line, as on the page. Its checklist isn't needed.
      console.log(await runStatus(await a.ctx(), await statusExtra(await a.ctx()), { engine: engineSource(exec, { checklist: false }) }));
      return 0;
    },
  },
  {
    name: "budget",
    summary: "PMX's daily usage cap: show it, set it in dollars, or turn it off (your Claude plan's own limits still apply)",
    usage: "pmx budget | pmx budget set <dollars> | pmx budget off",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const sub = a.positionals[0] ?? "show";
      if (sub === "set" || sub === "off") {
        const cap = ctx.team.caps.perDayUsd;
        const v = sub === "off" ? null : Number(a.positionals[1]);
        if (v !== null && (a.positionals[1] === undefined || !Number.isFinite(v) || v < 0)) throw new Error("Give a number of dollars, like `pmx budget set 10` (0 pauses PMX).");
        if (v !== null && v > cap) throw new Error(`Your team allows at most $${cap} a day (caps.perDayUsd in pmx.config.json).`);
        ctx.personal.budget = { ...ctx.personal.budget, dailyUsd: v };
        await savePersonalConfig(ctx.personal);
        console.log(v === null ? `No cap of your own now; your team's cap of $${cap} a day still applies.` : v === 0 ? "PMX is paused: no run calls the model until you raise the cap." : `Daily cap set to $${v}.`);
      } else if (sub !== "show") throw new Error(`Unknown subcommand "${sub}". Use set or off.`);
      const b = budget(ctx.personal, ctx.team, await loadState(), ctx.now());
      console.log(usageLine(b, ctx.personal.plan));
      console.log("Dollars are Claude Code's estimate at API list prices. On a Claude plan (Pro, Max, Team, Enterprise) runs count against your plan's usage limits instead of being billed per token; on an API key, Bedrock or Vertex they are what you pay.");
      return 0;
    },
  },
  {
    // RUN-6: Claude Code runs this, never a person: the PreToolUse hook a web run's settings name for WebSearch and
    // WebFetch. It reads the call on stdin, needs no config, and exits 2 to block.
    name: "hook",
    summary: "Claude Code's hook for a web run (web-guard): blocks a search or page that carries the task's evidence",
    usage: "pmx hook web-guard < tool-call.json",
    options: {},
    async run(a) {
      if (a.positionals[0] !== "web-guard") { process.stderr.write("pmx hook: the only hook is web-guard.\n"); return 2; }
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const r = await webGuardHook(Buffer.concat(chunks).toString("utf8"));
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.code;
    },
  },
  {
    name: "tick",
    summary: "One background run (launchd starts one every 30 minutes)",
    options: {},
    async run(a) {
      await capTickLogs();
      const ctx = await a.ctx();
      const lines = await runTick(ctx, tickSteps);
      for (const line of lines) console.log(`${new Date().toISOString()} ${line}`);
      await recordTick(lines);
      // SETUP-1: keep ~/.pmx/checklist.json current, so PMX's page and Claude see where this Mac stands without asking.
      await checklistNow(ctx).catch((e) => console.log(`${new Date().toISOString()} checklist: failed: ${e?.message ?? e}`));
      return 0;
    },
  },
  {
    name: "explain",
    summary: "Show how a run decided: what was read, left out, cut and masked, which skills ran, sizes, cost",
    usage: "pmx explain [<run id>] [--list] [--json] [--web]",
    options: { list: { type: "boolean" }, json: { type: "boolean" }, web: { type: "boolean" } },
    async run(a) {
      const personal = await loadPersonalConfig();
      const team = await loadTeamConfig(personal.repoPath);
      if (a.values.web) {
        const ctx = await a.ctx();
        const s = await startExplainServer({ team, personal, flow: (hours, scope) => loadFlowGraph(ctx, { level: scope === "team" ? "team" : "local", hours }) });
        await exec("open", [s.url]);
        console.log(`How PMX decided: ${s.url}\nOnly this Mac can open it. Press Ctrl+C to stop.`);
        await new Promise<void>((resolve) => process.on("SIGINT", () => s.close().then(resolve)));
        return 0;
      }
      const ids = await listReceipts();
      if (a.values.list) {
        console.log(ids.length ? ids.join("\n") : "No runs yet. Run `pmx digest`.");
        return 0;
      }
      const id = a.positionals[0] ?? ids[0];
      const r = id ? await readReceipt(id) : null;
      if (!r) {
        console.log(id ? `No run "${id}". See \`pmx explain --list\`.` : "No runs yet. Run `pmx digest`, then `pmx explain`.");
        return 1;
      }
      const live = await resolveLive(r, personal.sources.transcriptDirs);
      console.log(a.values.json ? JSON.stringify({ receipt: r, live }, null, 2) : formatReceipt(r, live));
      return 0;
    },
  },
  {
    name: "skills",
    summary: "List the Claude skills PMX can use; `sync` copies your org's skills from Linear, `publish` shares one with the team",
    usage: "pmx skills [--json] | pmx skills update <pmx-skill …> | pmx skills sync [--from <dir>] | pmx skills publish <name>",
    options: { json: { type: "boolean" }, from: { type: "string" } },
    async run(a) {
      if (a.positionals[0] === "sync") {
        const r = await syncOrgSkills({ fromDir: a.values.from });
        const lines = [`Synced org skills from ${r.from}.`];
        if (!r.adopted.length && !r.rejected.length) lines.push("Nothing to sync yet — no exported org skills found.");
        if (r.adopted.length) lines.push(`Adopted (now runnable): ${r.adopted.join(", ")}`);
        for (const x of r.rejected) lines.push(`Refused ${x.name}: ${x.reasons.join("; ")}`);
        console.log(lines.join("\n"));
        return r.rejected.length ? 1 : 0;
      }
      if (a.positionals[0] === "publish") {
        const name = a.positionals[1];
        if (!name) throw new Error("Give a skill name: pmx skills publish <name>");
        const ctx = await a.ctx();
        const path = teamSkillPath(ctx.personal.repoPath, name);
        const text = await readFile(path, "utf8").catch(() => null);
        if (!text) throw new Error(`No skill at ${path}. Author it first with \`pmx jobs new ${name}\`, then commit it.`);
        const { reasons } = await validateOrgSkill(text, name);
        if (reasons.length) throw new Error(`Can't publish "${name}": ${reasons.join("; ")}`);
        const access = await linearAccess(ctx.team, ctx.keychain);
        if (access !== "relay") {
          console.log(`Publishing with a Linear key or sign-in isn't wired yet; you're on "${access}". For now org-skill publish rides the Claude relay (the default).`);
          return 1;
        }
        await enqueueSkillDoc(name, text, ctx.now);
        console.log(`Queued "${name}" to publish as the Linear document "pmx-skill:${name}". The next "PMX: sync Linear through Claude" run uploads it; teammates then get it with \`pmx skills sync\`.`);
        return 0;
      }
      if (a.positionals[0] === "update") {
        // CAT-8: a team keeps its copies of PMX's skills until it asks for this pmx's, in a pull request a code owner reviews.
        const ctx = await a.ctx();
        const names = [...new Set(a.positionals.slice(1))];
        const differ = (await skillInventory(ctx.personal.repoPath, ctx.team.categories)).filter((s) => s.status === "differs from built-in").map((s) => s.name);
        if (!names.length) {
          console.log(differ.length
            ? `Your team's copies that differ from this PMX's: ${differ.join(", ")}.\nSend this PMX's to your team: pmx skills update ${differ.join(" ")}`
            : "Your team's copies of PMX's skills match this PMX's.");
          return 0;
        }
        const changes = names.map((name) => checkChange({ kind: "skill-update", name }, ctx.team));
        const pr = await proposeTeamChanges(ctx, changes);
        await rememberTeamPr({ id: pr.id, url: pr.url, at: ctx.now().toISOString(), changes: changes.map(describeChange) });
        console.log([
          `Sent this PMX's ${names.join(", ")} to your team for approval: ${pr.url}`,
          "",
          "If your team edited one of these, the pull request's diff shows what would change; keep your edits by editing it before it merges.",
          names.includes("pmx-size") ? "Your size rubric keeps every row your team has, and gains PMX's new ones." : null,
        ].filter((l) => l !== null).join("\n"));
        return 0;
      }
      if (a.positionals[0]) throw new Error(`Unknown subcommand "${a.positionals[0]}". Use update, sync or publish.`);
      const personal = await loadPersonalConfig();
      const team = await loadTeamConfig(personal.repoPath);
      const skills = await skillInventory(personal.repoPath, team.categories);
      console.log(a.values.json ? JSON.stringify(skills, null, 2) : formatSkills(skills));
      return 0;
    },
  },
  {
    name: "vendor",
    summary: "Put this CLI's package in the PMX repo, so teammates and CI install the same version; --require makes it the team minimum",
    usage: "pmx vendor [--require [--auto-update | --no-auto-update]] [--repo <PMX repo path>]",
    options: { repo: { type: "string" }, require: { type: "boolean" }, "auto-update": { type: "boolean" }, "no-auto-update": { type: "boolean" } },
    async run(a) {
      const repo = a.values.repo ?? (await loadPersonalConfig()).repoPath;
      const version = await vendorCli(repo, exec);
      if (a.values.require) {
        const file = join(repo, TEAM_CONFIG_FILE);
        const raw = (await readJson<Record<string, unknown>>(file)) ?? {};
        const prev = (raw.cli ?? {}) as { autoUpdate?: boolean };
        const autoUpdate = a.values["auto-update"] ? true : a.values["no-auto-update"] ? false : prev.autoUpdate;
        await writeJson(file, { ...raw, cli: { min: version, ...(autoUpdate !== undefined ? { autoUpdate } : {}) } }, 0o644);
      }
      console.log(vendorMessage({ repo, version, config: a.values.require ? TEAM_CONFIG_FILE : null, autoUpdate: a.values["auto-update"] === true }));
      return 0;
    },
  },
  {
    name: "install",
    summary: "Install PMX so a new Terminal window finds it (before PMX is installed: npx --yes productmaxxing@latest install); --engine adds PMX Engine",
    usage: "pmx install [--yes] [--engine]\n\nBefore PMX is installed: npx --yes productmaxxing@latest install\n  --yes     add PMX's folder to your PATH without asking (never installs PMX Engine)\n  --engine  install PMX Engine too: your team's product lead's tool. Your product lead is asked without it.",
    options: { ...yes, engine: { type: "boolean" } },
    async run(a) {
      // INSTALL-3, INSTALL-4. It may run from npx's copy, so it changes nothing PMX's own commands set up from where they
      // run (src/cli.ts skips the update steps for it): it installs PMX, then PATH, then Engine for the product lead.
      const personal = await loadPersonalConfig().catch(() => null);
      const team = personal ? await loadTeamConfig(personal.repoPath).catch(() => null) : null;
      const at = (bin?: string) => (bin ? { candidates: [join(bin, "pmxe"), ...pmxeCandidates()] } : {});
      return runInstall({
        exec, ask: a.ask, yes: a.values.yes === true, tty: !!process.stdin.isTTY, engine: a.values.engine === true,
        home: homedir(), shell: process.env.SHELL ?? "/bin/zsh", platform: process.platform, node: { version: process.versions.node, path: process.execPath },
        version: currentVersion(), root: packageRoot(), personal, team, writable: canWrite, say: (l) => console.log(l),
        pmxe: {
          find: (bin) => findPmxe(exec, at(bin)),
          async next(bin) {
            const r = await engineChecklist(exec, at(bin));
            return r && "checklist" in r ? r.checklist?.next?.title ?? null : null;
          },
        },
        async setupSkill() {
          if (!(await claudePresent())) return false;
          // A /pmx-setup of the PM's own stays theirs; either way there's one to type.
          await installAppSkill(SETUP_SKILL);
          return true;
        },
        updatedFrom: (v) => markUpdatingFrom(v),
      });
    },
  },
  {
    name: "update",
    summary: "Install your team's pmx version from the PMX repo (pulls the repo first), and update PMX Engine where it's installed; --check only compares versions; --latest installs the newest public release",
    usage: "pmx update [--check] [--force] [--latest]",
    options: { check: { type: "boolean" }, force: { type: "boolean" }, latest: { type: "boolean" } },
    async run(a) {
      if (a.values.latest) {
        const r = await installLatestRelease(exec, { force: a.values.force });
        if (r.result === "updated") {
          await showNewNotes(r.version);
          await showMigrate();
        }
        console.log({
          current: `pmx ${currentVersion()} is the latest release.`,
          updated: `Installed pmx ${"version" in r ? r.version : ""}. Team lead: run \`pmx vendor --require\` and merge it, so your team gets it too.`,
          "dev-install": "This pmx runs from a source checkout, so it isn't replaced. Pull and rebuild the checkout instead.",
          "needs-sudo": `npm can't write to its global folder. Install Node with Homebrew (brew install node), or run:\n  ${r.result === "needs-sudo" ? r.command : ""}`,
          failed: `Update failed: ${r.result === "failed" ? r.error : ""}`,
          "no-package": "",
        }[r.result]);
        await updateEngine();
        return r.result === "current" || r.result === "updated" ? 0 : 1;
      }
      const personal = await loadPersonalConfig();
      const repo = personal.repoPath;
      const git = new Git(repo, exec);
      if (await git.hasRemote()) {
        const pulled = await exec("git", ["-C", repo, "pull", "--ff-only", "--quiet"], { timeoutMs: 60000 });
        if (pulled.code !== 0) console.warn(`Couldn't pull the PMX repo (${pulled.stderr.trim() || "git pull failed"}); using what's checked out.`);
      }
      const team = await loadTeamConfig(repo).catch(() => null);
      const tgz = join(repo, VENDORED_CLI);
      const current = currentVersion();
      const vendored = await vendoredVersion(tgz, exec);
      const min = team?.cli?.min ?? null;
      const cloud = (await loadState()).cloudVersions;
      const engine = await findPmxe(exec);
      console.log([
        `This machine:  pmx ${current}`,
        `Team package:  ${vendored ? `pmx ${vendored} (${VENDORED_CLI})` : "none in the PMX repo"}`,
        `Team minimum:  ${min ?? "none set"}${min && !atLeast(current, min) ? "  ← this machine is too old for shared work" : ""}`,
        ...(cloud?.latest ? [`Latest release: pmx ${cloud.latest}`] : []),
        // COMPAT-7: where PMX Engine is on this Mac, `pmx update` updates it too. --check only says its version.
        ...(engine ? [`PMX Engine:    ${engine.version} on this Mac${a.values.check ? "" : ", updated next"}`] : []),
      ].join("\n"));
      if (a.values.check) return min && !atLeast(current, min) ? 1 : 0;
      const r = await installTeamVersion(repo, exec, { force: a.values.force });
      const say: Record<UpdateOutcome["result"], string> = {
        "no-package": "\nAsk your team lead to run `pmx vendor --require` and commit it.",
        current: "\nUp to date.",
        updated: `\nUpdated to pmx ${vendored}. The background job uses it from its next run.`,
        "dev-install": "\nThis pmx runs from a source checkout, so it isn't replaced. Pull and rebuild the checkout instead.",
        "needs-sudo": `\nnpm can't write to its global folder. Run:\n  ${r.result === "needs-sudo" ? r.command : ""}\nor install Node with Homebrew (brew install node), so updates (and auto-updates) don't need sudo.`,
        failed: `\nnpm install failed: ${r.result === "failed" ? r.error : ""}`,
      };
      console.log(say[r.result]);
      if (r.result === "updated") {
        await showNewNotes(r.version);
        await showMigrate();
      }
      if (engine) await updateEngine();
      // PMX's own update decides the exit code: Engine's refusing or failing is one sentence above, never a failure here.
      return r.result === "current" || r.result === "updated" ? 0 : 1;
    },
  },
  ...meetingCommands,
  ...linearCommands,
  ...teamCommands,
  ...flowCommands,
  ...settingsCommands,
  ...jobsCommands,
  {
    name: "whats-new",
    summary: "What's new in this pmx, or in every version after one you name; --json for Claude and scripts (NEW-1)",
    usage: "pmx whats-new [--since <version>] [--all] [--json]",
    options: { since: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
    async run(a) {
      if (a.values.since && !isVersion(String(a.values.since))) throw new Error(`--since takes a version like 0.10.1, not "${a.values.since}".`);
      const notes = a.values.all ? RELEASE_NOTES.filter((n) => (compareVersions(n.version, currentVersion()) ?? 0) <= 0) : notesBetween(a.values.since ? String(a.values.since) : null);
      // `pmx update` prints this from the pmx it just installed, so whoever ran the update (often Claude) is told to publish the pages again.
      const personal = await loadPersonalConfig().catch(() => null);
      const pages = personal ? stalePages(await loadTeamConfig(personal.repoPath).catch(() => null), personal, currentVersion()) : [];
      const note = personal ? await afterUpdateNote(await loadTeamConfig(personal.repoPath).catch(() => null), personal, exec, currentVersion()) : null;
      // On a Mac with PMX Engine, its notes this Mac hasn't seen follow PMX's (phase 2 of the join). Nothing changes without it.
      const engine = await engineNotes(exec);
      const engineText = formatEngineNotes(engine);
      console.log(a.values.json
        ? JSON.stringify({ version: currentVersion(), notes, pagesToUpdate: pages, ...(engine ? { engine } : {}) }, null, 2)
        : `${formatNotes(notes)}${note ? `\n\n${note}` : ""}${engineText ? `\n\n${engineText}` : ""}`);
      return 0;
    },
  },
  reviewCommand,
  ...cloudCommands,
  {
    name: "uninstall",
    summary: "Remove the background job, clean profile, keychain items and ~/.pmx",
    options: { ...yes },
    async run(a) {
      await runUninstall({ ask: a.ask, keychain: macKeychain(), oldKeychain: macKeychain(exec, OLD.keychain), launchd: macLaunchd(), exec, out: consoleOut, yes: a.values.yes });
      return 0;
    },
  },
];

/** Hooks later milestones (and ee/) fill in. */
export let inviteHook: ((i: InviteFile) => Promise<void>) | undefined;
export let doctorExtra: (() => Promise<import("./doctor.js").DoctorCheck[]>) | undefined;
export let statusExtra: (ctx: Ctx) => Promise<string[]> = async () => [];
/** SETUP-1: team features' checklist steps (ee/: the brain). */
export let checklistExtra: ((ctx: Ctx | null) => Promise<Step[]>) | undefined;

export function setHooks(h: { invite?: typeof inviteHook; doctor?: typeof doctorExtra; status?: typeof statusExtra; checklist?: typeof checklistExtra }): void {
  if (h.invite) inviteHook = h.invite;
  if (h.doctor) doctorExtra = h.doctor;
  if (h.status) statusExtra = h.status;
  if (h.checklist) checklistExtra = h.checklist;
}

async function doctorChecks() {
  let personal: PersonalConfig | null = null;
  let team: TeamConfig | null = null;
  let teamError: string | undefined;
  try {
    personal = await loadPersonalConfig();
    team = (await effectiveTeam(await loadTeamConfig(personal.repoPath), personal)).team;
  } catch (e: any) {
    teamError = e.message;
  }
  // R20: like every command that runs work, doctor writes the clean profile for the team before it checks it.
  return runDoctor({ personal, team, teamError, keychain: macKeychain(), oldKeychain: macKeychain(exec, OLD.keychain), launchd: macLaunchd(), exec, extra: doctorExtra, refreshProfile });
}
