import { stalePages } from "../claude/pages.js";
import { neverSynthesized } from "../synth/status.js";
import { agentHandle, autoUpdateOn } from "../core/config.js";
import { oldServerNote, oldServers } from "../mcp/handoff.js";
import { leftoverTasks, leftoverWhy, neededTasks, syncDueCron, taskRunHealth, taskState } from "../claude/tasks.js";
import { nodeSupported, profileSignedIn, resolveClaude } from "../core/claude-bin.js";
import { missingAllowRules } from "../claude/permissions.js";
import { linearAccess } from "../linear/access.js";
import { readOutbox, relayHealth } from "../tracker/relay.js";
import { directHealth } from "../linear/direct.js";
import { boardStale, boardUrl, boardWaits, checkBoard } from "../claude/board.js";
import { appSkillInstalled, BOARD_SKILL, claudePresent } from "../claude/skill.js";
import { loadState } from "../core/state.js";
import { VENDORED_CLI } from "../core/vendor.js";
import { atLeast, compareVersions, currentVersion, isPrerelease, vendoredVersion } from "../core/version.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import { onMac, type Exec } from "../core/exec.js";
import { Git } from "../core/git.js";
import { parseGitHubRemote, unsharedWork } from "../core/host.js";
import type { Keychain } from "../core/keychain.js";
import { killSwitchOn } from "../core/killswitch.js";
import { jobEnv, VERSIONED_NODE, type Launchd } from "../core/launchd.js";
import { paths, TEAM_CONFIG_FILE } from "../core/paths.js";
import { localGuard, profileChecks, webKinds, writeProfile, type Check } from "../core/profile.js";
import { RunLogStore } from "../core/runlog-store.js";
import { bundledSkillsDir, teamSkillPath } from "../core/skills.js";
import type { RunLogEntry } from "../core/runlog.js";
import { SIZES, type Size } from "../core/types.js";
import { tickHealth } from "./tick.js";
import { runCanaries } from "../core/canary.js";
import { privacyRules } from "../digest/gather.js";
import { OLD, renameLeftovers } from "../core/rename.js";
import { budget, budgetBlock } from "../budget/provider.js";
import { mcpHealth } from "../mcp/server.js";
import { teamSyncProblem } from "./team-sync.js";
import { engineChecks } from "../engine/bridge.js";
import { readThemes, THEMES_FORMAT } from "../synth/themes.js";

/** Days without an update check before `pmx doctor` says the background job isn't checking. */
export const AUTO_UPDATE_STALE_DAYS = 2;

export interface DoctorDeps {
  team: TeamConfig | null;
  teamError?: string;
  personal: PersonalConfig | null;
  keychain: Keychain;
  launchd: Launchd;
  exec: Exec;
  /** The Node binary the background job uses; tests pass their own. */
  execPath?: string;
  now?: () => Date;
  /** The keychain under its pre-0.15.0 name; tests pass their own. */
  oldKeychain?: Keychain;
  /** Extra checks from ee/ (license, policy). */
  extra?: () => Promise<DoctorCheck[]>;
  /** PMX Engine's checks; tests pass their own. */
  engine?: () => Promise<DoctorCheck[]>;
  /**
   * R20: writes the clean profile for the team first, as every command that runs work does, so the checks judge the
   * settings this Mac's next run gets (`pmx doctor` passes `refreshProfile`). Without it, the checks read what's there.
   */
  refreshProfile?: (team: TeamConfig) => Promise<void>;
}

/** R20: what `pmx doctor` writes before it checks: the clean profile, with this Mac's web guard. */
export async function refreshProfile(team: TeamConfig): Promise<void> {
  await writeProfile(team, { guard: await localGuard() });
}

export interface DoctorCheck extends Check {
  level: "fail" | "warn";
}

/** How to get a supported Node. nvm works too, but the background job breaks when that version is removed. */
export const NODE_FIX = "Install Node 24 with `brew install node` (or, with nvm: `nvm install 24 && nvm alias default 24`), open a new Terminal window, reinstall pmx (INSTALL.md step 2), then run `pmx init`";

/** Token shapes that must never appear in a plain-text config (SEC-10). */
const TOKEN_SHAPES = /\b(xox[abpr]-[\w-]{10,}|lin_(api|oauth)_\w{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|sk-ant-[\w-]{20,}|pmxm_\w{20,})/;


export async function runDoctor(d: DoctorDeps): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, level: "fail" | "warn" = "fail") => out.push({ id, ok, detail, level });

  add("os.macos", onMac(), "macOS (v1 supports macOS only, SCOPE-3)");
  add("node", nodeSupported(), `Node ${process.versions.node}${nodeSupported() ? "" : `: PMX needs 22.12 or later (24 recommended). ${NODE_FIX}`}`);
  // The background job keeps this Node's path, so a version manager switching or removing it stops the job.
  const execPath = d.execPath ?? process.execPath;
  if (/\/\.(nvm|fnm|volta|asdf)\/|\/n\/versions\//.test(execPath))
    add("node.path", false, `Node runs from a version manager (${execPath}); the background job breaks if that version is switched or removed. Recommended: brew install node, reinstall pmx, then \`pmx init\``, "warn");
  const cc = await resolveClaude(d.exec);
  add("claude.installed", !!cc, cc ? `Claude Code ${cc.version}${cc.onPath ? "" : ` at ${cc.cmd} (not on your shell's PATH; PMX finds it there)`}` : "Claude Code installed (https://code.claude.com)");
  // Each config folder has its own sign-in: a profile that isn't signed in fails every run with "Not logged in".
  const signIn = cc ? await profileSignedIn(d.exec) : null;
  if (signIn) add("profile.signed-in", signIn.ok, signIn.detail);
  // launchd has no shell PATH: an npm install of Claude Code under nvm is invisible to the job.
  const job = await d.launchd.installed();
  if (job) {
    // A job left pointing at a removed Node or Claude Code (a version manager's old folder, an upgraded Homebrew Node) stops silently.
    const env = jobEnv(job);
    const exists = (f: string) => stat(f).then(() => true, () => false);
    const gone = [
      ...(env.node && !(await exists(env.node)) ? [`Node at ${env.node}`] : []),
      ...(env.PMX_CLAUDE && !(await exists(env.PMX_CLAUDE)) ? [`Claude Code at ${env.PMX_CLAUDE}`] : []),
    ];
    const stale = [];
    for (const dir of env.PATH.split(":").filter((x) => /\/\.(nvm|fnm|volta|asdf)\//.test(x))) if (!(await exists(dir))) stale.push(dir);
    const versioned = !!env.node && VERSIONED_NODE.test(env.node);
    add("schedule.job-paths", !gone.length && !versioned, gone.length
      ? `the background job runs ${gone.join(" and ")}, which no longer exist${gone.length === 1 ? "s" : ""}, so it can't run: run \`pmx init\` again and say yes to the background job`
      : versioned ? `the background job runs Node from a versioned Homebrew folder (${env.node}); \`brew upgrade node\` will break it. Run \`pmx init\` again and say yes to the background job`
      : `the background job's Node${env.PMX_CLAUDE ? " and Claude Code" : ""} paths exist${stale.length ? ` (its PATH still names ${stale.join(", ")}, which is harmless)` : ""}`, gone.length ? "fail" : "warn");
  }
  if (job && cc) {
    const env = jobEnv(job);
    const r = await d.exec(env.PMX_CLAUDE ?? "claude", ["--version"], { env: { ...process.env, PATH: env.PATH }, timeoutMs: 15000 });
    add("schedule.job-claude", r.code === 0, r.code === 0
      ? `the background job finds Claude Code${env.PMX_CLAUDE ? ` at ${env.PMX_CLAUDE}` : ""}`
      : `the background job can't find Claude Code${cc.onPath ? "" : ` (it's at ${cc.cmd})`}, so its runs fail with "spawn claude ENOENT": run \`pmx init\` again and say yes to the background job`);
  }

  // RENAME-1: anything still under the ProductGit names after the move to ProductMaxxing.
  const left = await renameLeftovers(d.oldKeychain);
  if (left.length) add("rename.leftovers", false, `ProductGit is now ProductMaxxing, but ${left.join("; ")}. Run any pmx command (like \`pmx status\`) to finish moving; if that can't, run \`npm uninstall -g ${OLD.pkg} && npm install -g <the productmaxxing package>\` (README, "Updating")`, "warn");
  add("config.personal", !!d.personal, d.personal ? `personal config at ${paths.config()}` : "personal config missing: run `pmx init`");
  add("config.team", !!d.team, d.team ? `${TEAM_CONFIG_FILE} valid (team ${d.team.team})` : `team config: ${d.teamError ?? "missing"}`);
  if (!d.personal || !d.team) return [...out, ...(await (d.engine ?? (() => engineChecks(d.exec)))())];

  const repo = d.personal.repoPath;
  for (const f of ["CLAUDE.md", "memory", ".claude/settings.json", "CODEOWNERS"]) {
    const ok = await stat(join(repo, f)).then(() => true, () => false);
    add(`repo.${f}`, ok, `PMX repo has ${f}${f === "memory" ? " (shared team memory, B4)" : f === "CODEOWNERS" ? " (code owners on skills, memory, config)" : ""}`);
  }
  // R24: a team repo with a remote that isn't GitHub keeps drafts as local branches, and an accept pushes the base.
  const remote = await new Git(repo, d.exec).remoteUrl().catch(() => null);
  if (remote && !parseGitHubRemote(remote)) {
    add("repo.host", true, "team repo isn't on GitHub, so drafts wait as local branches on the Mac that drafted them; accepting one puts it on top of your team's latest base branch and pushes it to its remote (fast-forward only, never forced)");
  }
  // EQ-37 (bridge 3 of the join): PMX Engine's released strategy reaches agents only through CLAUDE.md.
  if (await stat(join(repo, "memory", "engine", "README.md")).then(() => true, () => false)) {
    const points = (await readFile(join(repo, "CLAUDE.md"), "utf8").catch(() => "")).includes("memory/engine");
    add("repo.memory-engine", points, points
      ? "agents find the released strategy in memory/engine/ through CLAUDE.md"
      : "memory/engine/ holds released strategy from PMX Engine, but CLAUDE.md doesn't point agents at it: add `@memory/engine/README.md` under \"Team memory\", in a pull request", "warn");
  }
  // EQ-38: roadmap themes are offered only from a themes.json this pmx can read.
  const themeList = await readThemes(repo);
  if (themeList.format !== null && themeList.format !== THEMES_FORMAT) {
    add("repo.engine-themes", false, `memory/engine/themes.json is at a format this pmx can't read (${themeList.format}), so it offers no roadmap themes: run \`pmx update\``, "warn");
  }
  // NEUT-2: each kind of work's skill lives in the team repo, so every Mac drafts from the same reviewed copy. R8: with
  // no team copy, a run uses the one this PMX ships, which works, so that only warns; only a skill nobody has fails.
  for (const [cat, { skill }] of Object.entries(d.team.categories)) {
    const ok = await stat(teamSkillPath(repo, skill)).then(() => true, () => false);
    const bundled = !ok && (await stat(join(bundledSkillsDir(), skill, "SKILL.md")).then(() => true, () => false));
    if (ok) add(`skill.${skill}`, true, `shared skill ${skill} for ${cat} in .claude/skills (NEUT-2)`);
    else if (bundled) add(`skill.${skill}`, false, `${cat} runs PMX's built-in ${skill}: your team has no copy in .claude/skills, so each Mac uses the one its own PMX ships. Send it to your team so every Mac drafts from the same copy: \`pmx skills update ${skill}\` (NEUT-2)`, "warn");
    else add(`skill.${skill}`, false, `no skill ${skill} for ${cat}: it isn't in your team's .claude/skills or in PMX, so agents can't draft ${cat}. Add its SKILL.md in a pull request, or take ${cat} out of ${TEAM_CONFIG_FILE} (NEUT-2)`);
  }
  const digestSkill = await stat(teamSkillPath(repo, "pmx-digest")).then(() => true, () => false);
  add("skill.pmx-digest", digestSkill, "shared skill pmx-digest in .claude/skills", "warn");

  if (d.refreshProfile) {
    const wrote = await d.refreshProfile(d.team).then(() => null, (e: any) => String(e?.message ?? e));
    if (wrote) add("profile.write", false, `PMX couldn't write its clean profile in ${paths.claudeProfile()}: ${wrote}`);
  }
  // R17: each run's settings as Claude Code merges them with the team repo's project settings.
  for (const c of await profileChecks(d.team, { repo })) add(c.id, c.ok, c.detail);
  // RUN-6: a team that opened competitive analysis to the web has a second set of run settings; one check covers them.
  if (webKinds(d.team).length) {
    const bad = (await profileChecks(d.team, { web: true, repo })).filter((c) => !c.ok);
    add("profile.web-run", !bad.length, bad.length
      ? `the web run's settings fail: ${bad.map((c) => `${c.id} (${c.detail})`).join("; ")}`
      : `web runs (${webKinds(d.team).join(", ")}) open only WebSearch and WebFetch, with the PMX repo's other project settings`);
  }

  // Versions (COMPAT-2, COMPAT-5): too old for the team fails; a newer team or release package warns.
  const current = currentVersion();
  const min = d.team.cli?.min;
  // The team package is what teammates and the background job install, so one older than this Mac warns too.
  const vendored = await vendoredVersion(join(repo, VENDORED_CLI), d.exec);
  const drift = vendored ? compareVersions(vendored, current) ?? 0 : 0;
  // COMPAT-6: updates arrive by themselves unless the team turned that off, and only a package the team's repo carries.
  const auto = autoUpdateOn(d.team) && (d.team.cli?.autoUpdate === true || !!vendored);
  const arrives = auto && drift > 0 ? "the background job installs your team's package within the hour, or " : "";
  add("cli.team-minimum", !min || atLeast(current, min), min ? `pmx ${current}; team minimum ${min}${atLeast(current, min) ? "" : `: ${arrives}run \`pmx update\`${arrives ? " now" : ""}`}` : `pmx ${current}; no team minimum set (\`pmx vendor --require\` sets one)`);
  add("cli.team-package", !vendored || drift === 0,
    !vendored ? `no CLI package in the PMX repo (\`pmx vendor\`)`
      : drift > 0 ? `team package is pmx ${vendored}, newer than this Mac's ${current}: ${auto ? "the background job installs it within the hour, or " : ""}run \`pmx update\`${auto ? " now" : ""}`
      : drift < 0 ? `team package is pmx ${vendored}, older than this Mac's ${current}: teammates who install or update get ${vendored}. Team lead: run \`pmx vendor --require\` and merge it`
      : `team package is pmx ${vendored}`, "warn");
  // Claude tasks (CLAUDE-1): PMX can't create them, so doctor says which are missing.
  const fix = (await appSkillInstalled()) ? "type /pmx-schedule in the Claude app" : "run `pmx schedule`";
  const tasks = await neededTasks(d.team, d.keychain);
  for (const t of tasks) {
    const state = await taskState(t);
    add(`claude.task.${t.id}`, state === "current", `Claude scheduled task "${t.title}"${state === "current" ? "" : state === "outdated" ? ` has an older prompt: ${fix}` : ` is missing: ${fix}`}`, "warn");
    if (state !== "missing") {
      const ran = await taskRunHealth(t, d.now?.() ?? new Date());
      add(`claude.task.${t.id}.ran`, ran.ok, `"${t.title}" ${ran.detail}`, "warn");
    }
  }
  // CLAUDE-3: without always-allow rules, a scheduled run waits on a prompt nobody answers and blocks later runs.
  if (await claudePresent()) {
    const rules = await missingAllowRules();
    add("claude.allow", !rules.length, rules.length ? `scheduled tasks will stop to ask permission (${rules.join(", ")} not allowed): run \`pmx schedule --allow\`` : "scheduled tasks may run pmx and use ~/.pmx without asking", "warn");
  }
  // The Claude board (BOARD-1), only where Claude and Linear are both in use.
  if ((await checkBoard(d.team)).ok) {
    const b = boardUrl(d.team, d.personal);
    // The board reads Linear only: it needs publishing again only when its page changed (0.36.0).
    // This Mac's own board: the one it published, also when the team shares that same board in its settings (as
    // src/claude/pages.ts counts it, so the line after an update names it too). A board a teammate shared is theirs.
    const mine = !!b && !!d.personal.board?.url && (b.source === "personal" || b.url === d.personal.board.url);
    const stale = mine && boardStale(d.personal.board, current);
    // 0.41.0: a board published with its own republish capability takes the newer page itself, once its owner opens it.
    const waits = mine && boardWaits(d.personal.board, current);
    const how = (await appSkillInstalled(BOARD_SKILL)) ? "type /pmx-board in the Claude app" : "run `pmx board --install-skill`, then type /pmx-board in the Claude app";
    add("claude.board", !!b && !stale && !waits, b
      ? `team board ${b.url}${stale ? `: published with an older pmx, and its page changed since; ${how} to update it` : waits ? ": its page changed in a PMX update, and it updates itself the next time you open it in the Claude app on this Mac" : ""}`
      : `no Claude board yet: ${how}`, "warn");
  }
  const st = await loadState();
  // SIG-6: Linear connected and meetings collected, but no task ever proposed on this Mac.
  const never = await neverSynthesized(d.team, d.personal, agentHandle(d.personal), st.lastSynthAt, !!(await d.launchd.installed().catch(() => null)), d.now?.() ?? new Date()).catch(() => null);
  if (never) add("synth.never", false, never, "warn");
  if (auto) {
    const au = st.autoUpdate;
    const stuck = au && (au.result === "needs-sudo" || au.result === "failed");
    // The job checks hourly while the Mac is awake; days without a check mean it isn't running, whatever the last result said.
    const days = au ? Math.floor(((d.now?.() ?? new Date()).getTime() - Date.parse(au.checkedAt)) / 86400000) : 0;
    const stale = days >= AUTO_UPDATE_STALE_DAYS;
    add("cli.auto-update", !stuck && !stale, au
      ? `auto-update on; last check ${au.checkedAt.slice(0, 16).replace("T", " ")}: ${stuck ? `pmx ${au.version} is waiting, run \`pmx update\`` : au.result === "dev-install" ? "source checkout, not replaced" : au.result}${stale ? `, ${days} days ago: the background job hasn't checked since` : ""}`
      : "auto-update on; the background job hasn't checked yet", "warn");
  }
  // JOB-10: a checkout that stopped following the team's repo means different kinds of work from everyone else's.
  const behind = teamSyncProblem(st, d.now?.() ?? new Date());
  if (behind) add("team.sync", false, behind, "warn");
  // D2-2: an accepted draft only on this Mac is one the team doesn't have: a warning with what to run, never a ✔.
  if (remote && !parseGitHubRemote(remote)) {
    const unshared = await unsharedWork(new Git(repo, d.exec), st.teamPush).catch(() => null);
    add("team.push", !unshared, unshared ? unshared.text : "every accept on this Mac is in your team's repo", "warn");
  }
  const cloud = st.cloudVersions;
  // The latest release is never a test build (0.41.0-next.2): one named here by mistake is left out, not offered.
  if (cloud?.latest && !isPrerelease(cloud.latest)) add("cli.latest", (compareVersions(cloud.latest, current) ?? 0) <= 0, `latest release is pmx ${cloud.latest}`, "warn");

  // FLOW-3: fake confidential meetings must be held by today's rules and this PM's do-not-read list.
  // BUDGET-2: a cap of 0 or a used-up day stops every run, so it's never silent.
  const b = budget(d.personal, d.team, st, d.now?.() ?? new Date());
  const blocked = budgetBlock(b);
  add("budget", !blocked, blocked ?? `budget: ${b.personalCapUsd === null ? `no cap of your own, team cap $${b.capUsd.toFixed(2)} a day` : `$${b.capUsd.toFixed(2)} a day`}, $${b.spentUsd.toFixed(2)} used today (estimated at list prices)`, "warn");
  const rules = privacyRules({ team: d.team, personal: d.personal });
  // B2: without the company's own domain, PMX can't tell colleagues from customers, so it holds every meeting.
  add("privacy.company-domains", rules.internalDomains.length > 0, rules.internalDomains.length
    ? `meetings with only ${rules.internalDomains.join(", ")} attendees count as internal and never reach the team's tracker`
    : "PMX doesn't know your company's email domain, so it holds every meeting from team tasks and your digest. Run `pmx init` and give your work email domain (or add it to internalDomains in pmx.config.json)");
  const can = runCanaries(rules);
  add("privacy.canaries", !can.failed.length, can.failed.length ? `privacy rules let ${can.failed.length} test meeting(s) through (${can.failed.join(", ")}): nothing is sent, but check internalDomains in pmx.config.json and your do-not-read list` : `privacy rules hold all ${can.total} test meetings (1:1s, internal-only, hiring, pay, performance, health, fundraising${rules.confidentialDomains.length ? ", a confidential contact" : ""}${rules.neverIngest.meetingTitles.length || rules.neverIngest.people.length ? ", do-not-read" : ""})`);
  // F5: a suggestion, never a failure. Fundraising meetings are held by their title and content; an investor's call
  // about something else is held only when the team lists the investor's domain.
  add("privacy.confidential-domains", rules.confidentialDomains.length > 0, confidentialNote(rules.confidentialDomains), "warn");
  // R5: a suggestion, never a failure. PMX swaps the people it finds; a list also catches a contact it can't tell apart.
  const crm = await crmNames(d.personal.crmNamesFile);
  add("privacy.crm-names", crm.ok, crm.detail, "warn");
  // FLOW-4/5: the /pmx-flow board reads this Mac through a server the Claude app starts.
  const mh = await mcpHealth();
  if (mh) add("flow.mcp", mh.ok, mh.detail, "warn");
  else if (d.personal.flow?.url) add("flow.mcp", false, "the /pmx-flow page can't reach PMX on this Mac: run `pmx mcp --install`, then restart the Claude app", "warn");
  // FLOW-4: a server the Claude app started before this pmx was installed, from before 0.24.1, still runs the old code.
  if (mh) {
    const old = await oldServers(d.exec);
    if (old.length) add("flow.mcp-old", false, oldServerNote(old.length)!.replace(/^The/, "the"), "warn");
  }
  // FLOW-5: the /pmx-flow page runs the code of the pmx that published it; publishing it again keeps its link.
  const fp = stalePages(null, { flow: d.personal.flow ?? null, board: null }, current)[0];
  if (fp) add("flow.page", false, `your /pmx-flow page is from pmx ${fp.publishedVersion ?? "an older version"}: type /pmx-flow in the Claude app to update it to ${current}, keeping its link`, "warn");

  const loose: string[] = [];
  for (const dir of [paths.home(), paths.staging(), paths.receipts(), paths.transcripts()]) {
    const st = await stat(dir).catch(() => null);
    if (st && st.mode & 0o077) loose.push(dir);
  }
  add("home.private", !loose.length, loose.length ? `readable by other users on this Mac: ${loose.join(", ")}. Fix: chmod 700 ${loose.join(" ")}` : `${paths.home()} is private to you (drafts, receipts, transcripts)`);

  let leaked = false;
  for (const f of [paths.config(), join(repo, TEAM_CONFIG_FILE)]) {
    const t = await readFile(f, "utf8").catch(() => "");
    if (TOKEN_SHAPES.test(t)) leaked = true;
  }
  add("secrets.not-in-config", !leaked, "no tokens in plain-text config (SEC-10)");
  const have = new Set(await d.keychain.list());
  // Slack channels come through the PM's Slack connector in Claude (INPUT-1); a token is only for the digest DM.
  if (d.personal.digest.slackDmUserId) add("secrets.slack", have.has("slack-token"), "Slack token in the keychain, for the digest DM");
  // Linear is checked the way this Mac reaches it (LINEAR-1, LINEAR-2): the relay needs no token, so it can't fail here.
  const access = await linearAccess(d.team, d.keychain);
  if (access === "key") {
    add("secrets.linear", true, "Linear API key in the keychain");
    // LINEAR-2 (0.41.0): how the key is doing, from what PMX's own reads recorded. A key Linear rejects is a failure
    // said in plain words; doctor asks Linear nothing itself.
    const h = await directHealth(d.team, d.now?.() ?? new Date(), { waiting: (await readOutbox().catch(() => ({ ops: [] }))).ops.length });
    add("linear.direct", h.ok, h.detail, h.problem?.kind === "key-rejected" ? "fail" : "warn");
    // A sync task left in the Claude app from before the key: said, and never a problem.
    const left = await leftoverTasks(d.team, d.keychain).catch(() => []);
    if (left.length) add("linear.task-left", true, leftoverWhy(left[0]!), "warn");
  }
  if (access === "signed-in") add("secrets.linear", true, "signed in to Linear");
  if (access === "relay") {
    const h = await relayHealth(d.team, d.now?.() ?? new Date(), { cron: await syncDueCron(d.personal.taskHours) });
    add("linear.relay", h.ok, h.detail, "warn");
  }

  // PMX runs on the PM's Claude subscription; only Free has no Claude Code.
  const plan = d.personal.plan;
  add("model.plan", plan !== "free", plan === "free" ? "Claude Free doesn't include Claude Code: PMX needs a Pro, Max, Team or Enterprise plan" : `model plan "${plan}"`, "warn");

  const jobLoaded = await d.launchd.isLoaded();
  add("schedule.launchd", jobLoaded, jobLoaded
    ? "one launchd job registered (runs `pmx tick` every 30 min)"
    : "no background job on this Mac, so PMX doesn't pull your team's repo, update itself or run on its own: turn on automatic runs on your PMX page, or run `pmx init`", "warn");
  const tick = tickHealth(st.lastTick, 3, d.now?.() ?? new Date());
  if (tick) add("schedule.tick", tick.ok, tick.detail, "warn");

  const git = new Git(repo, d.exec);
  const ks = await killSwitchOn(git).catch(() => ({ on: false, reason: null }));
  add("killswitch", !ks.on, ks.on ? `kill switch is ON (${ks.reason}): no agent takes work` : "kill switch off", "warn");

  const store = new RunLogStore({ repo: git, exec: d.exec });
  const v = !(await store.exists())
    ? { ok: true, entries: 0, agents: 0, problems: [] }
    : await store.verify().catch((e) => ({ ok: false, entries: 0, agents: 0, problems: [String(e.message)] }));
  add("runlog.chain", v.ok, v.ok ? `run log chain intact (${v.entries} entries, ${v.agents} agents)` : `run log: ${v.problems.slice(0, 3).join("; ")}`);

  if (v.ok && v.entries) {
    for (const s of calibrate(await store.entries(), d.team)) add(`calibrate.${s.size}`, false, s.text, "warn");
  }

  if (d.extra) out.push(...(await d.extra()));
  // PMX Engine's checks, on a Mac that has it (phase 2 of the join): warnings only, read from `pmxe doctor --json`.
  out.push(...(await (d.engine ?? (() => engineChecks(d.exec)))()));
  return out;
}

/**
 * Size calibration (PULL-10): compares the median cost and duration of successful runs per size
 * with the team's estimates and suggests new ones when they're off by more than half.
 */
export function calibrate(entries: RunLogEntry[], team: TeamConfig, minRuns = 5): { size: Size; text: string }[] {
  const out: { size: Size; text: string }[] = [];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
  };
  for (const size of SIZES) {
    const runs = entries.filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.outcome === "ok" && e.size === size);
    if (runs.length < minRuns) continue;
    const est = team.sizes[size];
    const cost = median(runs.map((r) => r.costUsd ?? 0));
    const minutes = median(runs.map((r) => r.durationMs / 60000));
    const off = (a: number, b: number) => b > 0 && Math.abs(a - b) / b > 0.5;
    if (off(cost, est.costUsd) || off(minutes, est.minutes))
      out.push({ size, text: `size ${size}: ${runs.length} runs took a median ${minutes.toFixed(0)} min and $${cost.toFixed(2)}; pmx.config.json says ${est.minutes} min and $${est.costUsd.toFixed(2)}. Suggest "${size}": { "minutes": ${Math.ceil(minutes)}, "costUsd": ${cost.toFixed(2)} }` });
  }
  return out;
}

/** How a team lists its confidential contacts, in doctor's and the checklist's words (F5). */
export const CONFIDENTIAL_HOW = "send their email domains to your team with `pmx domains confidential add <domain>` (a pull request a teammate approves), or add them to confidentialDomains in pmx.config.json";

/** F5: what doctor says about the team's confidential domains. Only domains, which are team settings. */
export function confidentialNote(domains: string[]): string {
  return domains.length
    ? `meetings, emails and threads with someone from ${domains.join(", ")} are held from team work, and those companies' names never reach Linear`
    : `your team lists no investors or other confidential contacts. PMX holds fundraising meetings by their title and what's said, but an investor's call about something else reads like a customer call. To list them, ${CONFIDENTIAL_HOW}`;
}

/** `pmx doctor --json`: what an install script (or Claude, following INSTALL.md) checks. */
/** How to add the customer name list, in doctor's and the checklist's words (R5). */
export const CRM_NAMES_HOW = "save your customers' contacts in a text file, one full name per line (an export from your CRM works), then set \"crmNamesFile\" to the file's full path in ~/.pmx/config.json";

/**
 * R5: the CRM name list (`crmNamesFile` in the personal config), as a suggestion. PMX swaps every person it finds in the
 * sources for a placeholder; a contact it can't tell from an ordinary word ("Mark", "Will") is swapped everywhere only
 * when the list names them. Counts only: the names are never shown.
 */
export async function crmNames(file: string | null | undefined): Promise<{ ok: boolean; detail: string }> {
  if (!file) return { ok: false, detail: `no customer name list. PMX swaps the people it finds in your sources (speakers, attendees, names in the text) for placeholders like [PERSON-2, Globex] before a quote reaches your team's repo; a list of your customers' names also catches one it can't tell from an ordinary word. To add one, ${CRM_NAMES_HOW}` };
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { ok: false, detail: `PMX can't read your customer name list at ${file}, so it swaps only the people it finds itself: check the path in ~/.pmx/config.json ("crmNamesFile"), which must be the file's full path` };
  const n = new Set(text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 3)).size;
  return n ? { ok: true, detail: `customer name list: ${n} ${n === 1 ? "name" : "names"}, swapped for placeholders wherever they appear` }
    : { ok: false, detail: `your customer name list at ${file} has no names yet: put one full name per line` };
}

export function doctorJson(checks: DoctorCheck[]) {
  const failed = checks.filter((c) => !c.ok && c.level === "fail").map((c) => c.id);
  const warnings = checks.filter((c) => !c.ok && c.level === "warn").map((c) => c.id);
  return { ok: !failed.length, version: currentVersion(), node: process.versions.node, failed, warnings, checks };
}

export function formatDoctor(checks: DoctorCheck[]): { text: string; ok: boolean } {
  const lines = checks.map((c) => `${c.ok ? "\u001b[32m✔\u001b[0m" : c.level === "warn" ? "\u001b[33m!\u001b[0m" : "\u001b[31m✘\u001b[0m"} ${c.detail}`);
  const fails = checks.filter((c) => !c.ok && c.level === "fail").length;
  const warns = checks.filter((c) => !c.ok && c.level === "warn").length;
  lines.push("", fails ? `${fails} check(s) failed, ${warns} warning(s).` : `All required checks passed${warns ? `, ${warns} warning(s)` : ""}.`);
  return { text: lines.join("\n"), ok: fails === 0 };
}
