import { boardUrl, checkBoard, renderBoard } from "../claude/board.js";
import { addAllowRules, ALLOW_RULES, claudeSettingsFile, missingAllowRules } from "../claude/permissions.js";
import { APP_SKILL, appSkillCurrent, appSkillInstalled, appSkillTarget, BOARD_SKILL, claudeAppHome, claudePresent, FLOW_SKILL, installAppSkill, SETUP_SKILL, skillInstalledByPmx, type AppSkill } from "../claude/skill.js";
import { choseClaudeApp, linearAccess, rememberClaudeApp } from "../linear/access.js";
import { adoptKey, checkLinearKey, keyHelp, KEY_QUESTION, rollupTeams } from "../linear/switch.js";
import type { Fetch } from "../sources/slack.js";
import { createHash } from "node:crypto";
import { access, constants, mkdir, readdir, stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Asker } from "../core/ask.js";
import { agentHandle, DEFAULT_TEAM, loadTeamConfig, savePersonalConfig, validateTeamConfig, type PersonalConfig, type Plan, type TeamConfig } from "../core/config.js";
import { claudeAbsolutePath, detectPlan, loginProfile, profileSignedIn, resolveClaude } from "../core/claude-bin.js";
import { onMac, type Exec } from "../core/exec.js";
import { privateDir, readJson } from "../core/fsutil.js";
import { Git } from "../core/git.js";
import type { Keychain } from "../core/keychain.js";
import { plist, stableNode, type Launchd } from "../core/launchd.js";
import { paths, pmxHome, TEAM_CONFIG_FILE } from "../core/paths.js";
import { writeProfile } from "../core/profile.js";
import { scaffoldRepo } from "../core/scaffold.js";
import { vendoredFiles, vendorCli } from "../core/vendor.js";
import type { Out } from "../core/context.js";
import { desktopAppPresent, desktopConfig, installMcp, mcpInstalled } from "../mcp/server.js";
import { cleanDomain, companyDomains } from "../core/filter.js";
import { channelInputs, connectorId } from "../inputs/inputs.js";
import { linearRef } from "../core/config.js";
import { restartNeeded, type AppFacts } from "../setup/claude-setup.js";

export interface InviteFile {
  version: 1;
  controlPlaneUrl: string;
  orgId: string;
  inviteCode: string;
  team: { repo?: string; linearTeamKey?: string; linearProjectId?: string };
}

export interface InitDeps {
  ask: Asker;
  keychain: Keychain;
  launchd: Launchd;
  exec: Exec;
  out: Out;
  now: () => Date;
  /** Absolute path to the CLI entry, for the launchd job. */
  cliPath: string;
  invite?: InviteFile | null;
  /** Called after the invite is accepted (ee/), to sign in and fetch the policy. */
  onInvite?: (invite: InviteFile) => Promise<void>;
  /** Signs in PMX's Claude profile; tests pass their own. */
  login?: (exec: Exec) => Promise<number>;
  /**
   * `pmx init --ask`: every question, each with what PMX worked out as its default. Without it init asks only what a
   * person must answer and shows the rest in the summary (CLI-2).
   */
  askAll?: boolean;
  /** `pmx init --repo <folder or git URL>`: the team's PMX repo, so init doesn't ask where it is. */
  repo?: string;
  /** The home folder: a new or cloned team repo goes in `<home>/pmx`. Tests pass their own (or PMX_REPO_HOME_FOR_TESTS), never the real one. */
  home?: string;
  /** The folder init runs in: a clone of the team's repo there is found without asking. Tests pass their own. */
  cwd?: string;
  /**
   * Nobody can answer here: no terminal, and no `--yes`. A question's default isn't a person's yes, so init then makes
   * none of the changes outside ~/.pmx and opens no browser, and says so (INIT-1).
   */
  unattended?: boolean;
  /**
   * `--yes`: every question takes its default. A default isn't an answer about a Linear key, so with it init neither
   * asks for one nor remembers a choice; the next `pmx init` or `pmx linear key` in Terminal asks (LINEAR-2).
   */
  yes?: boolean;
  /** How init reaches Linear to check a pasted key. Tests pass their own; nothing under vitest reaches the real one. */
  fetch?: Fetch;
}

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** A stable, non-identifying machine ID: a hash, not the hostname itself. */
export function machineId(): string {
  return "m" + createHash("sha256").update(hostname()).digest("hex").slice(0, 8);
}

/** Asks until `check` finds no problem. Gives up after three tries, so a script or a pasted command never loops. */
async function askValid(d: InitDeps, q: string, def: string, check: (a: string) => string | null | Promise<string | null>): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const a = (await d.ask.text(q, def)).trim();
    const problem = await check(a);
    if (!problem) return a;
    d.out.warn(`${problem}. Try again.`);
  }
  throw new Error(`No valid answer to "${q}" after three tries. Nothing was saved; run \`pmx init\` again.`);
}

/** Answers that are really a command typed into the wrong prompt (a shell command or a Claude slash command). */
export function looksLikeCommand(a: string): boolean {
  return /^(pmx|npm|npx|node|git|gh|brew|claude|cd|sudo|ls)(\s|$)/i.test(a) || /^\/[a-z][\w-]*$/i.test(a) || /^-/.test(a);
}

/** A folder for the PMX repo: an existing folder, or one this user can create. */
export async function checkFolder(a: string): Promise<string | null> {
  if (!a) return "Enter a folder";
  if (looksLikeCommand(a)) return `"${a}" looks like a command, not a folder`;
  let p = expand(a);
  const st = await stat(p).catch(() => null);
  if (st) return st.isDirectory() ? null : `${p} is a file, not a folder`;
  // Walk up to the nearest folder that exists; PMX creates the rest, so that one must be writable.
  while (!(await stat(p).then(() => true, () => false))) p = dirname(p);
  return access(p, constants.W_OK).then(() => null, () => `You can't create folders in ${p}`);
}

/** A git URL (https, ssh, scp-style, file) or a local repo folder. Blank means "create a new repo". */
export async function checkGitUrl(a: string): Promise<string | null> {
  if (!a) return null;
  if (looksLikeCommand(a)) return `"${a}" looks like a command, not a git URL`;
  if (/^(https?|ssh|git|file):\/\/\S+$/.test(a) || /^[\w.-]+@[\w.-]+:\S+$/.test(a)) return null;
  if (await stat(join(expand(a), ".git")).then(() => true, () => false)) return null;
  if (await isBareRepo(expand(a))) return null;
  return "Enter a git URL like https://github.com/acme/pmx.git or git@github.com:acme/pmx.git";
}

/** What older pmx versions read as working hours: always. Since 0.13.0 PMX works whenever the Mac is on. */
export const ALWAYS = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00" };

/** A git URL as a person gives it: https, ssh, git or file, or scp-style (git@host:path). */
export const isGitUrl = (a: string) => /^(https?|ssh|git|file):\/\/\S+$/.test(a) || /^[\w.-]+@[\w.-]+:\S+$/.test(a);

const present = (f: string) => stat(f).then(() => true, () => false);
const hasGit = (dir: string) => present(join(dir, ".git"));
/**
 * A bare git repo: the copy others clone from and push to (a shared drive, a server, `git init --bare`). It has git's own
 * files at its top and no checkout, so it is never a folder for PMX to write in: PMX clones it, as it would a git URL.
 */
export const isBareRepo = async (dir: string) => !(await hasGit(dir)) && (await Promise.all(["HEAD", "objects", "refs"].map((n) => present(join(dir, n))))).every(Boolean);
const BARE_HINT = "is a bare git repo, the copy others clone from, not a checkout";
/** A folder PMX may fill without asking: not there yet, or empty (a fresh clone of an empty repo, with only its `.git`, is empty too). */
const emptyOrAbsent = (dir: string) => readdir(dir).then((names) => names.every((n) => n === ".git"), () => true);
const tilde = (p: string) => (p === homedir() || p.startsWith(`${homedir()}/`) ? `~${p.slice(homedir().length)}` : p);
const sameUrl = (a: string, b: string) => a.trim().replace(/\/$/, "").replace(/\.git$/, "") === b.trim().replace(/\/$/, "").replace(/\.git$/, "");

/** The four things `pmx init` changes outside PMX's own folder, each only with the PM's yes (INIT-1). */
export type SystemChangeId = "job" | "skills" | "allow" | "mcp";
interface SystemChange {
  id: SystemChangeId;
  /** Its name in the list the PM says yes to. */
  title: string;
  /** One line: what it changes and where. */
  line: string;
  /** The question when the PM is asked about this one alone (`--ask`, or "pick"). */
  question: string;
  apply(): Promise<void>;
}

/**
 * Sets PMX up on this Mac. It asks only what a person must answer (CLI-2): where the team's repo is, a new team's name
 * and Linear project, a company domain or token it can't find, one yes for everything it changes, and on a Linear team
 * the PM's own Linear API key (LINEAR-2; Return means the Claude app's sync instead, and is remembered). What it can
 * detect or decide (the handle, the plan, kinds of work, the cap, folders) it shows in the summary and applies;
 * `askAll` (`pmx init --ask`) asks about each instead. Running it again asks nothing it already knows.
 */
export async function runInit(d: InitDeps): Promise<PersonalConfig> {
  const { ask, out } = d;
  const all = !!d.askAll;
  if (!onMac()) throw new Error("ProductMaxxing v1 runs on macOS only (SCOPE-3).");

  const cc = await resolveClaude(d.exec);
  out.info(cc ? `Found Claude Code ${cc.version}${cc.onPath ? "" : ` at ${cc.cmd}`}.` : "Claude Code was not found. Install it from https://code.claude.com, then run `pmx doctor`.");

  const existing = await readJson<PersonalConfig>(paths.config());
  /**
   * The settings a question was really asked about in this run. On a Mac that's set up, init writes those and nothing
   * else: every other saved setting stays exactly as it is (INIT-1).
   */
  const answered = new Set<"handle" | "plan" | "categories" | "cap" | "domains" | "transcripts" | "neverIngest" | "dm">();
  /** A question PMX has an answer for: asked with `--ask`, or when that answer doesn't pass its own check. */
  const settled = async (key: typeof answered extends Set<infer K> ? K : never, q: string, def: string, check: (a: string) => string | null | Promise<string | null>): Promise<string> => {
    if (!all && !(await check(def))) return def;
    answered.add(key);
    return askValid(d, q, def, check);
  };

  // 1. The PMX repo. Cloning a repo the PM named is the only write before the summary.
  const defaultRepo = existing?.repoPath ?? join(d.home ?? process.env.PMX_REPO_HOME_FOR_TESTS ?? homedir(), "pmx");
  let repoPath = defaultRepo;
  let repoNote = "existing repo";
  /** Whether the repo's folder was PMX's to fill: it wasn't there, or was empty, before this run. */
  let freshFolder = false;
  const cloneInto = async (u: string, dest: string) => {
    await mkdir(dirname(dest), { recursive: true });
    // `--` so an answer can never be read as a git option.
    const r = await d.exec("git", ["clone", "--", u, dest]);
    return r.code === 0 ? null : `git clone failed: ${r.stderr.trim().split("\n").pop()}`;
  };
  const invited = d.invite?.team.repo;
  if (all) {
    out.info("PMX keeps your team's shared skills, memory and settings in a git repo, the \"PMX repo\". On your own? Accept the default and PMX creates one. Joining a team? Give the folder where you cloned it, or its git URL at the next question.");
    repoPath = expand(await askValid(d, "Path to your team's PMX repo checkout", defaultRepo, async (a) => (await checkFolder(a)) ?? ((await isBareRepo(expand(a))) ? `${tilde(expand(a))} ${BARE_HINT}. Give the folder to clone it into, and that path at the next question` : null)));
    freshFolder = await emptyOrAbsent(repoPath);
    if (!(await hasGit(repoPath))) {
      if (invited) {
        const problem = (await checkGitUrl(invited)) ?? (await cloneInto(invited, repoPath));
        if (problem) throw new Error(`The invite's repo ${invited} couldn't be cloned (${problem}). Ask your team lead for a new invite.`);
      }
      const url = invited ?? (await askValid(d, "No git repo there. Git URL of your team's PMX repo (blank to create a new one)", "", async (u) => (await checkGitUrl(u)) ?? (u ? cloneInto(u, repoPath) : null)));
      repoNote = url ? `cloned from ${url}` : "new repo";
      if (url) freshFolder = false;
    }
  } else {
    // Where the clone of a URL goes: the usual folder when it's free or already that clone, else one named for the repo.
    const cloneTo = async (u: string): Promise<string | null> => {
      const named = join(dirname(defaultRepo), u.replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "").replace(/[^\w.-]/g, "") || "pmx-team");
      for (const dest of [...new Set([defaultRepo, named])]) {
        const origin = (await hasGit(dest)) ? (await d.exec("git", ["-C", dest, "config", "--get", "remote.origin.url"])).stdout.trim() : null;
        if (origin !== null && sameUrl(origin, u)) { repoPath = dest; repoNote = `already cloned from ${u}`; return null; }
        if (origin === null && (await emptyOrAbsent(dest))) {
          const problem = await cloneInto(u, dest);
          if (!problem) { repoPath = dest; repoNote = `cloned from ${u}`; }
          return problem;
        }
      }
      return `${tilde(defaultRepo)} and ${tilde(named)} both hold something else. Clone ${u} where you want it, then run pmx init --repo <that folder>`;
    };
    /** A folder or git URL the PM gave. Blank is a new team's repo in the usual folder. */
    const place = async (a: string): Promise<string | null> => {
      if (!a) { repoPath = defaultRepo; return null; }
      if (looksLikeCommand(a)) return `"${a}" looks like a command, not a git URL or a folder`;
      if (isGitUrl(a)) return cloneTo(a);
      if (!/^(\/|~(\/|$)|\.{1,2}(\/|$))/.test(a)) return "Enter a git URL like https://github.com/acme/pmx.git or git@github.com:acme/pmx.git, or a folder's full path like ~/pmx";
      const problem = await checkFolder(a);
      if (problem) return problem;
      // A bare repo is where the team's copies come from: PMX clones it and never writes in it.
      if (await isBareRepo(expand(a))) return cloneTo(expand(a));
      repoPath = expand(a);
      return null;
    };
    // Known already, in this order: named on the command line, saved by an earlier init, in the invite, or a clone PMX
    // can see (this folder, or the usual one). Only when none is does init ask.
    const here = d.cwd ?? process.cwd();
    const isPmxRepo = async (dir: string) => (await hasGit(dir)) && (await present(join(dir, TEAM_CONFIG_FILE)));
    const known = d.repo?.trim() ? { where: d.repo.trim(), how: "" }
      : existing && (await hasGit(existing.repoPath)) ? { where: existing.repoPath, how: "" }
      : invited ? { where: invited, how: "your invite names it" }
      : (await isPmxRepo(here)) ? { where: here, how: "this folder is a clone of it" }
      : (await isPmxRepo(defaultRepo)) ? { where: defaultRepo, how: "found there" }
      : null;
    if (known) {
      const problem = await place(known.where);
      if (problem) throw new Error(invited && known.where === invited ? `The invite's repo ${invited} couldn't be cloned (${problem}). Ask your team lead for a new invite.` : `${problem}. Nothing was saved.`);
      if (known.how) out.info(`Your team's PMX repo: ${tilde(repoPath)} (${known.how}). For another, run pmx init --repo <folder or git URL>.`);
    } else {
      out.info("PMX keeps your team's shared skills, memory and settings in a git repo, the \"PMX repo\". Joining a team? Give its git URL and PMX clones it, or the folder you cloned it to. Starting one, or on your own? Press Return and PMX creates it.");
      await askValid(d, `Your team's PMX repo: its git URL, or the folder you cloned it to (blank starts a new one in ${tilde(defaultRepo)})`, "", place);
    }
    // The clone, if any, is done: the folder is PMX's to fill only when nothing is in it yet.
    freshFolder = await emptyOrAbsent(repoPath);
    if (!(await hasGit(repoPath))) repoNote = "new repo";
  }

  let team: TeamConfig;
  let newRepo: { team: string; tracker: TeamConfig["tracker"] } | null = null;
  try {
    team = await loadTeamConfig(repoPath);
    out.info(`Using team config for "${team.team}".`);
  } catch {
    // A folder PMX just made holds nothing to lose; a clone or a folder with files in it might be the wrong one, so that asks.
    // Defence in depth: whatever led here, PMX never sets a team up inside a bare repo.
    if (await isBareRepo(repoPath)) throw new Error(`${tilde(repoPath)} ${BARE_HINT}. Run pmx init --repo with the folder you cloned it to, or with its path and PMX clones it. Nothing was saved.`);
    // A folder that holds something already is set up only on a typed yes: Return, and a run nobody answers, leave it alone.
    if ((all || !freshFolder) && !(await ask.confirm(`${tilde(repoPath)} has no pmx.config.json${freshFolder ? "" : ", and it already holds files"}. Set it up as a new PMX repo?`, freshFolder)))
      throw new Error(`A PMX repo needs pmx.config.json, and ${tilde(repoPath)} has none. Joining a team? Ask your team lead for the repo or an invite file. Starting one there? Run pmx init again and answer yes. Nothing was saved.`);
    const teamName = await askValid(d, "Team name", "product", (a) => (/^\w[\w .-]{0,39}$/.test(a) ? null : "Use up to 40 letters, numbers, spaces, dots or dashes"));
    // A pasted Linear link works too: PMX keeps only the team key or the project's slug (the connector takes no URLs).
    const linearTeamKey = linearRef("team", d.invite?.team.linearTeamKey ?? (await askValid(d, "Linear team key, like ENG, or the team's Linear link (blank for none yet)", "", (a) => (!a || /^[a-z][a-z0-9]{0,9}$/i.test(linearRef("team", a)) ? null : "A Linear team key is a short code like ENG or PRO2")))).toUpperCase();
    const linearProjectId = linearTeamKey
      ? linearRef("project", d.invite?.team.linearProjectId ?? (await askValid(d, "Linear PMX project ID or link (blank to add later)", "", (a) => (!a || (/^[\w-]{3,}$/.test(linearRef("project", a)) && !looksLikeCommand(a)) ? null : "Paste the project's ID or its link from Linear"))))
      : "";
    newRepo = { team: teamName, tracker: linearTeamKey && linearProjectId ? { kind: "linear", teamKey: linearTeamKey, projectId: linearProjectId } : { kind: "none" } };
    team = validateTeamConfig({ ...DEFAULT_TEAM, ...newRepo });
  }

  // 2. About this PM. Each has an answer PMX can work out, so each is asked only with --ask.
  const userDefault = (process.env.USER ?? "pm").replace(/[^\w-]/g, "") || "pm";
  const handle = await settled("handle", "Your handle (short, no spaces, used in branch names)", existing?.handle ?? userDefault, (a) => (/^[\w-]{1,32}$/.test(a) ? null : "Use letters, numbers, - or _ only"));
  const plans: Plan[] = ["team", "enterprise", "api", "bedrock", "vertex", "pro", "max"];
  const signedInPlan = existing || all ? null : await detectPlan(d.exec).catch(() => null);
  if (all) answered.add("plan");
  const plan = all ? ((await ask.choose<Plan>("Model plan for runs", plans, existing?.plan ?? "team")) as Plan) : existing?.plan ?? signedInPlan ?? "team";
  const cats = Object.keys(team.categories);
  // A saved kind the team no longer has isn't asked about (and stays saved, untouched, unless the kinds are asked).
  const catsDefault = existing ? existing.categories.filter((c) => all || cats.includes(c)) : cats;
  const catsCheck = (a: string) => {
    const unknown = split(a).filter((c) => !cats.includes(c));
    return unknown.length ? `Unknown: ${unknown.join(", ")}. Pick from ${cats.join(", ")}` : split(a).length ? null : "Pick at least one";
  };
  const catsAnswer = (catsDefault.length || all ? catsDefault : cats).join(", ");
  // JOB-11: leaving a kind out is a choice only when the PM was shown the kinds. A rerun that asks nothing keeps what
  // they chose before, so a kind the team added since is still theirs to decide (Needs you asks).
  const categories = split(await settled("categories", `Categories your agent accepts (${cats.join(", ")})`, catsAnswer, catsCheck));
  const cap = team.caps.perDayUsd;
  // BUDGET-1: on a Claude plan the dollars are an estimate at list prices, not a bill, so there's no cap of PMX's own by default.
  const billed = isBilledPlan(plan);
  const capDefault = existing ? (existing.budget.dailyUsd === null ? "" : String(existing.budget.dailyUsd)) : billed ? String(Math.min(10, cap)) : "";
  const capAnswer = await settled("cap", billed
    ? `Daily spend cap for PMX's runs, in USD (your team allows up to ${cap})`
    : `Daily cap on PMX's usage, in USD at API list prices (blank for none: your Claude plan's own limits apply, and your team's cap of $${cap})`, capDefault, (a) => {
    const n = Number(a);
    if (a === "" && !billed) return null;
    return a === "" || !Number.isFinite(n) || n < 0 ? "Enter a number of dollars, like 10" : n > cap ? `Your team allows at most ${cap} a day` : null;
  });
  const dailyUsd = capAnswer === "" ? null : Number(capAnswer);
  if (dailyUsd === 0) out.warn("A cap of 0 pauses every PMX run until you raise it with `pmx budget set <dollars>`.");

  // B2: the company's own domains tell colleagues from customers. Without one PMX holds every meeting. The team's
  // settings and the PM's git email usually say; only when neither does is this a question.
  const workEmail = (await d.exec("git", ["config", "--get", "user.email"]).catch(() => null))?.stdout.trim() ?? "";
  const known = companyDomains(team.internalDomains, { companyDomains: existing?.companyDomains, emails: [...(existing?.identity?.emails ?? []), workEmail] });
  if (all || !known.length) answered.add("domains");
  const domainsAnswer = all || !known.length
    ? await askValid(d, "Your company's email domains, like acme.com (meetings with only these people are internal and never reach the team)", known.join(", "), (a) => {
      const bad = split(a).filter((x) => !cleanDomain(x));
      return bad.length ? `"${bad[0]}" isn't an email domain like acme.com` : null;
    })
    : known.join(", ");
  const domains = split(domainsAnswer).map((x) => cleanDomain(x)!);
  if (!domains.length) out.warn("No company domain: PMX holds every meeting from team tasks until you add one.");

  // 3. Sources (default-deny, B2).
  const transcriptDirs = team.allowedSources.includes("transcripts")
    ? split(await settled("transcripts", "Folders with call transcripts to include (comma-separated)", (existing?.sources.transcriptDirs ?? [paths.transcripts()]).join(", "), (a) => (split(a).some(looksLikeCommand) ? "That looks like a command, not a folder" : null))).map(expand)
    : [];
  // Slack channels are read through the PM's Slack connector in Claude (INPUT-1), so there's no channel or token to ask for.
  const slackTeam = channelInputs(team).some((c) => connectorId(c.connector) === "slack");
  // The do-not-read list starts empty and the digest DM off: `pmx never-ingest add` and PMX's page change them any time.
  if (all) answered.add("neverIngest");
  const listed = async (q: string, have: string[] | undefined) => (all ? split(await ask.text(q, have?.join(", ") ?? "")) : have ?? []);
  const people = await listed("Never ingest anything involving these people (names or emails, comma-separated)", existing?.neverIngest.people);
  const meetingTitles = await listed("Never ingest meetings whose titles contain (comma-separated)", existing?.neverIngest.meetingTitles);
  const channels = await listed("Never ingest these channels (comma-separated)", existing?.neverIngest.channels);
  if (slackTeam && all) answered.add("dm");
  const dm = !slackTeam ? "" : all
    ? await askValid(d, "Your Slack member ID, to DM you the approved digest (blank to skip)", existing?.digest.slackDmUserId ?? "", (a) => (!a || /^[UW][A-Z0-9]{6,}$/.test(a) ? null : "A Slack user ID looks like U012AB3CD"))
    : existing?.digest.slackDmUserId ?? "";

  /** A Mac's first setup: every answer and default, as the summary shows them. */
  const first = (): PersonalConfig => ({
    version: 1,
    handle,
    machineId: machineId(),
    repoPath,
    installedAt: d.now().toISOString(),
    plan,
    categories,
    // JOB-11: the kinds offered here and left out are a choice, so PMX doesn't ask about them again.
    categoriesOff: cats.filter((c) => !categories.includes(c)),
    // No longer used (0.13.0), and written as "always" so an older pmx reading this file behaves the same.
    workingHours: ALWAYS,
    budget: { dailyUsd, resetHour: 0, overrideUsd: null },
    companyDomains: domains,
    sources: { transcriptDirs, slackChannel: null },
    neverIngest: { people, channels, meetingTitles },
    crmNamesFile: null,
    digest: { weekday: 5, slackDmUserId: dm || null },
  });
  /**
   * A Mac that's set up: the saved settings as they are, with only what was asked about in this run changed (and the
   * repo, when another was named). Nothing else is rebuilt, defaulted or tidied: not the working hours an older pmx
   * saved, not today's budget override, not a setting this pmx doesn't know (INIT-1).
   */
  const again = (saved: PersonalConfig): PersonalConfig => {
    const p = structuredClone(saved);
    if (p.repoPath !== repoPath) p.repoPath = repoPath;
    if (answered.has("handle")) p.handle = handle;
    if (answered.has("plan")) p.plan = plan;
    if (answered.has("categories")) {
      p.categories = categories;
      p.categoriesOff = [...new Set([...(saved.categoriesOff ?? []).filter((c) => !cats.includes(c)), ...cats.filter((c) => !categories.includes(c))])];
    }
    if (answered.has("cap")) p.budget = { ...saved.budget, dailyUsd };
    if (answered.has("domains")) p.companyDomains = domains;
    if (answered.has("transcripts")) p.sources = { ...saved.sources, transcriptDirs };
    if (answered.has("neverIngest")) p.neverIngest = { ...saved.neverIngest, people, channels, meetingTitles };
    if (answered.has("dm")) p.digest = { ...saved.digest, slackDmUserId: dm || null };
    return p;
  };
  const personal: PersonalConfig = existing ? again(existing) : first();

  // What init would change outside ~/.pmx (INIT-1): the background job, PMX's commands and allow rules in the Claude
  // app's own folder, and PMX's server in the desktop app's settings. Each needs the PM's yes; none is ever silent.
  const node = await stableNode(process.execPath);
  const jobPlist = async () => plist({ node, cli: d.cliPath, pmxHome: pmxHome(), claude: await claudeAbsolutePath(d.exec) });
  const board = await checkBoard(team);
  // CLAUDE-2, SETUP-1, FLOW-5, BOARD-1: /pmx-setup does the Claude app's part in one chat; the other three do one part each.
  const skillNames: AppSkill[] = [SETUP_SKILL, APP_SKILL, FLOW_SKILL, ...(board.ok ? [BOARD_SKILL as AppSkill] : [])];
  const slash = (names: AppSkill[]) => names.map((n) => `/${n}`).join(", ").replace(/, ([^,]*)$/, " and $1");
  const changes: Record<SystemChangeId, SystemChange> = {
    job: {
      id: "job", title: "Background job",
      line: `registers the launchd job com.productmaxxing.pmx (${tilde(paths.launchAgent())}), which runs \`pmx tick\` every 30 minutes while this Mac is awake`,
      question: "Register the background job (runs `pmx tick` every 30 minutes)?",
      async apply() {
        await mkdir(paths.logs(), { recursive: true });
        const claude = await claudeAbsolutePath(d.exec);
        await d.launchd.install(await jobPlist());
        out.info(`Registered launchd job com.productmaxxing.pmx${claude ? `, using Claude Code at ${claude}` : ""}.`);
      },
    },
    skills: {
      id: "skills", title: "Claude commands",
      line: `adds ${slash(skillNames)} to your Claude app's own commands (${tilde(join(claudeAppHome(), "skills"))}), so one chat there finishes the setup: PMX's scheduled tasks, its page${board.ok ? " and your team's board" : ""}`,
      question: `Add ${slash(skillNames)} to your Claude app, so Claude can finish PMX's setup in one chat: its scheduled tasks, its page${board.ok ? " and your team's live board" : ""}?`,
      async apply() {
        const added: AppSkill[] = [];
        for (const name of skillNames) {
          const r = await installAppSkill(name).catch(() => null);
          if (r === "kept-yours") out.warn(`Left your own ${appSkillTarget(name)} alone.`);
          else if (r === "installed" || r === "updated") added.push(name);
        }
        if (added.length) out.info(`Added ${slash(added)} to your Claude app's commands.`);
        if (board.ok) await renderBoard(team).catch(() => null);
      },
    },
    allow: {
      id: "allow", title: "Allow rules",
      // CLAUDE-3: scheduled runs stall on prompts nobody answers, so offer always-allow rules for PMX's own command and folder.
      line: `adds ${ALLOW_RULES.join(", ")} to your Claude settings (${tilde(claudeSettingsFile())}), so PMX's scheduled tasks run pmx and use ~/.pmx without stopping to ask`,
      question: `Let PMX's scheduled tasks run pmx and use ~/.pmx without asking each time? (adds ${ALLOW_RULES.join(", ")} to your Claude settings)`,
      async apply() {
        const r = await addAllowRules();
        if (r.error) out.warn(r.error);
        else if (r.added.length) out.info(`Added ${r.added.join(", ")} to your Claude settings.`);
      },
    },
    mcp: {
      id: "mcp", title: "PMX's server",
      // FLOW-4: PMX's page in Claude reads PMX through a local server the Claude desktop app starts. Offered, not silent,
      // because it changes the app's settings.
      line: `adds PMX's server to the Claude desktop app's settings (${tilde(desktopConfig())}), so PMX's page there works on this Mac. Any Claude chat on this Mac can then read PMX's counts, never meeting or task titles, and add to your do-not-read list`,
      question: "Let your /pmx-flow board in the Claude app read PMX on this Mac? (adds PMX's server to the Claude desktop app. Any Claude chat on this Mac can then read PMX's counts, never meeting or task titles, and add to your do-not-read list)",
      async apply() {
        const r = await installMcp(node, d.cliPath);
        if (r.error) out.warn(r.error);
        else out.info("Added PMX's server to the Claude desktop app. Restart the Claude app once so it starts.");
      },
    },
  };
  /** Whether a change is still to make on this Mac. With `--ask` the job and the commands are offered every time, as before. */
  const open: Record<SystemChangeId, (ahead: boolean) => Promise<boolean>> = {
    job: async () => all || !(await d.launchd.isLoaded()) || (await d.launchd.installed()) !== (await jobPlist()),
    // Open while one is missing or older than this pmx. A copy the PM wrote themselves is theirs, and counts as there.
    skills: async () => all || (await Promise.all(skillNames.map(async (n) => (await appSkillCurrent(n)) || ((await appSkillInstalled(n)) && !(await skillInstalledByPmx(n)))))).includes(false),
    // `ahead`: listed before the commands are added, which is what puts the Claude folder there.
    allow: async (ahead) => (ahead || (await claudePresent())) && (await missingAllowRules()).length > 0,
    mcp: async () => (await desktopAppPresent()) && !(await mcpInstalled()),
  };
  const ORDER: SystemChangeId[] = ["job", "skills", "allow", "mcp"];
  const pending: SystemChangeId[] = [];
  if (!all) for (const id of ORDER) if (await open[id](pending.includes("skills") || (await claudePresent()))) pending.push(id);
  const signedIn = await profileSignedIn(d.exec).catch(() => null);

  // 4. Nothing is written until the PM has seen every answer.
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tracker = team.tracker.kind === "linear" ? `Linear ${team.tracker.teamKey}` : "no Linear yet";
  // Nothing was asked about and the repo is the same: the saved settings are not written again, so the file stays as it is, byte for byte.
  const unchanged = !!existing && !newRepo && isDeepStrictEqual(personal, existing);
  if (unchanged && !pending.length && !all) out.info(`\nPMX is set up on this Mac as ${handle}, with team "${team.team}" in ${tilde(repoPath)}. Nothing to change: pmx init --ask goes through every answer.`);
  else out.info([
    "",
    "PMX will save this setup:",
    `  PMX repo       ${repoPath} (${repoNote}, team "${team.team}", ${tracker})`,
    `  You            ${handle}, ${plan} plan`,
    `  Agent work     ${categories.join(", ")}`,
    `  Spend          ${dailyUsd === null ? `no cap of your own (team cap $${cap} a day, estimated at list prices)` : `up to $${dailyUsd} a day${dailyUsd === 0 ? " (paused)" : ""}`}; PMX works whenever this Mac is on and awake`,
    `  Company        ${domains.join(", ") || "no domain set: every meeting is held from team tasks"}`,
    // INPUT-3: a new team's first Mac is its synthesis Mac, so its approved channels are read from day one.
    ...(newRepo ? [`  Synthesis Mac  this one (${handle}), as your team's first: it suggests team tasks and reads the channels your team approves`] : []),
    `  Transcripts    ${transcriptDirs.join(", ") || "none"}`,
    ...(slackTeam ? [`  Slack DM       ${dm || "none"} (channels come through your Slack connector in Claude)`] : []),
    `  Never ingest   ${count(people.length, "person", "people")}, ${count(meetingTitles.length, "meeting title")}, ${count(channels.length, "channel")}`,
    `  Saved to       ${paths.config()}`,
    ...(all ? [] : [
      "PMX worked out everything you weren't asked. To change any of it: pmx init --ask.",
      ...(pending.length ? ["", `With your yes, PMX also changes ${count(pending.length, "thing")} outside its own folder (~/.pmx):`, ...pending.map((id, n) => `  ${n + 1}. ${changes[id].title.padEnd(16)} ${changes[id].line}`)] : []),
      ...(signedIn?.ok === false ? ["", "Then your browser opens once, to sign in PMX's own Claude profile (~/.pmx/claude): agent runs fail without it, and your usual Claude setup never loads in them."] : []),
    ]),
  ].join("\n"));

  // One yes (INIT-1). "pick" saves the setup and asks about each change; "no" saves nothing and changes nothing.
  let each = all;
  if (d.unattended && (all || pending.length))
    out.warn(`Nobody can answer here (no terminal, and no --yes), so PMX changes nothing outside its own folder${all ? "" : `: none of the ${count(pending.length, "change")} above`}. Run \`pmx init\` in Terminal to say yes.`);
  if (all) {
    if (!(await ask.confirm("Save this setup?", true))) throw new Error("Nothing was saved. Run `pmx init` again to change your answers.");
  } else if (d.unattended) {
    // The setup is PMX's own file, saved as shown; everything that needs a yes waits for a person.
  } else if (pending.length) {
    const n = pending.length;
    const go = await ask.choose(`Go ahead? yes: save this and make ${n === 1 ? "that change" : `those ${n} changes`}. pick: save it, and choose ${n === 1 ? "about the change" : "each change"}. no: save nothing`, ["yes", "pick", "no"], "yes");
    if (go === "no") throw new Error("Nothing was saved, and nothing on this Mac was changed. Run `pmx init` again when you're ready.");
    each = go === "pick";
  } else if (!unchanged && !(await ask.confirm("Save this setup?", true))) throw new Error("Nothing was saved. Run `pmx init` again to change your answers.");

  if (newRepo) {
    if (await isBareRepo(repoPath)) throw new Error(`${tilde(repoPath)} ${BARE_HINT}. PMX never sets a team up inside one.`);
    if (!(await hasGit(repoPath))) {
      await mkdir(repoPath, { recursive: true });
      await d.exec("git", ["init", "-q", "-b", "main", repoPath]);
    }
    const git = new Git(repoPath, d.exec);
    // The new team's settings, as the summary showed them. PMX can't tell who else will join, so a new team repo's
    // first Mac is its synthesis Mac (INPUT-3); a teammate who joins later can pick another on Sources, for review.
    const created = await scaffoldRepo(repoPath, { ...newRepo, internalDomains: domains, synthesizer: handle });
    // Teammates and CI install the CLI from the repo, so they don't need npm access to it.
    await vendorCli(repoPath, d.exec).then(
      () => created.push(...vendoredFiles()),
      (e) => out.warn(`Couldn't add the CLI package to the repo (${e.message}). Run \`pmx vendor\` later.`),
    );
    out.info(`Created ${created.length} files in ${repoPath}.`);
    // In a folder PMX made, everything is PMX's own, so the commit needs no question; anywhere else it might take the PM's files with it.
    if (created.length && ((!all && freshFolder) || (await ask.confirm("Commit the PMX repo setup now?", true)))) {
      await git.ok(["add", "-A"]);
      await git.ok(["commit", "-q", "-m", "Set up PMX repo with ProductMaxxing"]);
      out.info("Committed. Push it and protect main with required code-owner review (see CODEOWNERS).");
    }
    team = await loadTeamConfig(repoPath);
  }
  const git = new Git(repoPath, d.exec);

  // ~/.pmx holds transcripts, drafts and receipts: private to this user (PRIV-1). Folders the PM picks keep their own permissions.
  await privateDir(pmxHome());
  for (const dir of transcriptDirs) await (resolve(dir) === resolve(paths.transcripts()) ? privateDir(dir) : mkdir(dir, { recursive: true }));
  if (!unchanged) await savePersonalConfig(personal);

  // Secrets go to the keychain only (SEC-10), typed by the PM here and nowhere else. One is asked for only where the
  // team's setup needs it and nothing on this Mac already answers: with `gh` signed in, PMX opens pull requests through it.
  const onGitHub = !!(await git.remoteUrl())?.includes("github.com");
  const ghSignedIn = async () => { const r = await d.exec("gh", ["auth", "token"]).catch(() => null); return !!r && r.code === 0 && !!r.stdout.trim(); };
  const secrets: [Parameters<Keychain["set"]>[0], string, () => Promise<boolean>][] = [
    ["slack-token", "Slack bot token with chat:write, only to DM you the approved digest (blank to skip)", async () => !!dm],
    ["github-token", "GitHub token for opening PRs in the PMX repo (blank to use `gh`)", async () => onGitHub && (all || !(await ghSignedIn()))],
  ];
  for (const [name, q, needed] of secrets) {
    if ((await d.keychain.get(name)) || !(await needed())) continue;
    const v = await ask.secret(q);
    if (v) await d.keychain.set(name, v);
  }

  // LINEAR-2 (0.41.0, Founder 2026-11-27): a personal Linear API key is how PMX reaches Linear by default. Asked once,
  // of a person (never where nobody can answer, and never answered by --yes), in PMX's own no-echo prompt, with where
  // to create it and the least it must be allowed. Checked with Linear before it's saved; a key that can't see the
  // team's PMX project is refused with what's missing. Return means "use the Claude app instead", which PMX remembers,
  // so a rerun asks again only with --ask. The key goes to the keychain and nowhere else (SEC-10).
  if (!d.unattended && !d.yes && (await linearAccess(team, d.keychain)) === "relay" && (all || !(await choseClaudeApp()))) {
    const reach: Fetch = d.fetch ?? (process.env.PMX_TEST_NO_REAL_SYSTEM ? (async () => { throw new Error("A test reached the real Linear API. Tests pass their own fetch."); }) as unknown as Fetch : fetch);
    const rollup = rollupTeams(team, { handle: personal.handle, agent: agentHandle(personal) });
    const deps = { team, keychain: d.keychain, fetch: reach, now: d.now };
    out.info(["", ...keyHelp(team, { rollup })].join("\n"));
    for (let tries = 0; ; tries++) {
      const key = (await ask.secret(tries ? "Linear API key (paste another, or Return to use the Claude app instead)" : KEY_QUESTION)).trim();
      if (!key) {
        await rememberClaudeApp(d.now());
        out.info("No key: PMX reaches Linear through your Claude app's Linear connector, once an hour. /pmx-setup sets its sync task up. To use a key later: pmx linear key.");
        break;
      }
      const check = await checkLinearKey(deps, key, { rollup });
      for (const l of check.lines) (check.ok ? out.info : out.warn)(l);
      if (check.ok) {
        for (const l of (await adoptKey(deps, key)).lines) out.info(l);
        break;
      }
      if (tries >= 2) { out.warn("Three keys didn't pass, so PMX goes through your Claude app's Linear connector for now. When you have a key that does: pmx linear key."); break; }
    }
  }

  // 5. Clean profile (B1) and the one launchd job. The profile has its own sign-in; without it every run fails.
  await writeProfile(team);
  if ((await profileSignedIn(d.exec))?.ok === false) {
    out.info("PMX runs Claude Code with its own profile (~/.pmx/claude), so your personal setup never loads. It needs its own sign-in.");
    // Only the PM can sign in, in their browser; the summary said it comes next, so it isn't asked again.
    if (d.unattended) out.warn("Nobody is here to sign in, so agent runs fail until you run `pmx claude login` in Terminal.");
    else if (!all || (await ask.confirm("Sign in PMX's Claude profile now? (opens your browser)", true))) {
      if (!all) out.info("Opening your browser to sign in PMX's Claude profile…");
      if ((await (d.login ?? loginProfile)(d.exec)) !== 0) out.warn("Sign-in didn't finish. Run `pmx claude login` later; agent runs fail until then.");
    } else out.warn("Agent runs fail until PMX's profile is signed in. Run `pmx claude login` later.");
  }
  /** One change, in its turn: made on the PM's one yes, or asked about by itself with `--ask` or "pick". */
  const change = async (id: SystemChangeId) => {
    if (d.unattended || (all ? !(await open[id](false)) : !pending.includes(id))) return;
    if (each && !(await ask.confirm(changes[id].question, true))) return;
    await changes[id].apply();
  };
  await change("job");
  if (d.invite && d.onInvite) await d.onInvite(d.invite);
  await change("skills");
  await change("allow");
  // An earlier yes to PMX's server is kept up to date with this pmx's paths, as every update does.
  if ((await desktopAppPresent()) && (await mcpInstalled())) {
    const r = await installMcp(node, d.cliPath);
    if (r.changed) out.info("Updated PMX's server in the Claude desktop app to this pmx. Restart the Claude app once.");
  } else await change("mcp");
  const reaches = await linearAccess(team, d.keychain);
  if (reaches === "key") out.info("Linear: PMX reaches it with your API key, with every background run.");
  // Someone who chose the Claude app was told so at the question; a Mac where nobody could be asked is told what's usual.
  else if (reaches === "relay" && !(await choseClaudeApp())) out.info("Linear: PMX reaches it through your Claude app's Linear connector for now, once an hour. PMX's usual way is your own Linear API key, which syncs with every background run: run pmx linear key in Terminal.");
  out.info("\nSetup done. For its first week your agent is in practice mode: it says which task it would take, without running it.");
  return personal;
}

/**
 * The one "Next step" block, printed after doctor so it's the last thing the PM reads: the Claude app's part, which one
 * chat does (SETUP-1), with the app's restart before it and only when the app needs one.
 */
export async function nextSteps(team: TeamConfig, personal: PersonalConfig, app: AppFacts = { desktopApp: false, mcpRegistered: false, serverRunning: false }, yesLeft: { lacks: string[]; must: boolean } | null = null): Promise<string> {
  const lines = ["Next step:"];
  const board = (await checkBoard(team)).ok && !boardUrl(team, personal);
  if (yesLeft?.must) {
    // Init's one question got no yes (nobody could answer, or the answer was no): that is the next step, said plainly.
    const list = yesLeft.lacks.length < 3 ? yesLeft.lacks.join(" and ") : `${yesLeft.lacks.slice(0, -1).join(", ")} and ${yesLeft.lacks.at(-1)}`;
    lines.push(`  1. Run \`pmx init\` again in Terminal and answer its one question. PMX still lacks ${list} on this Mac, and one yes makes ${yesLeft.lacks.length === 1 ? "it" : "them all"}. Nothing runs by itself until then.`);
    lines.push("  2. Then quit the Claude app completely (⌘Q), open it again, and type /pmx-setup in its Code tab: in one chat Claude creates PMX's scheduled tasks and publishes PMX's page.");
    lines.push("  3. When Claude says so, click \"Run now\" on each PMX task once and choose \"Always allow\".");
  } else if (await appSkillInstalled(SETUP_SKILL)) {
    lines.push(restartNeeded(app) === "yes"
      ? "  1. Quit the Claude app completely (⌘Q) and open it again, once, so it has PMX's commands and starts PMX's server."
      : "  1. Open the Claude desktop app. If /pmx-setup isn't among its commands, quit it (⌘Q) and open it again.");
    lines.push(`  2. In its Code tab, type /pmx-setup. In that one chat Claude creates PMX's scheduled tasks and publishes PMX's page${board ? " and your team's board" : ""}.`);
    lines.push("  3. When Claude says so, click \"Run now\" on each PMX task once and choose \"Always allow\", so later runs don't stop to ask.");
  } else {
    lines.push("  1. Run `pmx checklist --install-skill` to add /pmx-setup to your Claude app, then type /pmx-setup in its Code tab: one chat creates PMX's scheduled tasks and publishes PMX's page.");
    lines.push("     Without it: run `pmx schedule` and paste what it prints into the Claude desktop app (Code tab), in a session with auto mode off.");
  }
  lines.push("After that:");
  lines.push(`  · Meetings arrive by themselves from your meeting app; transcripts you have as files go in ${personal.sources.transcriptDirs[0] ?? "a transcripts folder"}.`);
  lines.push("  · Tasks PMX suggests from your calls wait for you on PMX's page (or `pmx proposals`). Nothing reaches Linear until you approve.");
  lines.push("  · `pmx checklist` says where this Mac stands any time; `pmx open` opens PMX's page on this Mac.");
  const shared = boardUrl(team, personal);
  if (shared) lines.push(`Your team's board: ${shared.url}`);
  return lines.join("\n");
}

/** Plans billed per token, where PMX's dollar figures are real charges (BUDGET-1). */
export const isBilledPlan = (p: Plan) => p === "api" || p === "bedrock" || p === "vertex";
