// CLI-2, INIT-1, SETUP-1, INSTALL-3: the short path. `pmx init` asks only what a person must answer and takes one yes
// for everything it changes outside ~/.pmx; one /pmx-setup chat does the Claude app's part; `npx productmaxxing install`
// goes straight on to init. Nothing here touches the real home, ~/.claude, launchd, the Claude app, GitHub or Linear:
// the home, the Claude folders and the desktop app's settings are temp folders, launchd and the keychain are fakes,
// and `claude`, `gh` and `npm` are stand-ins. Only git runs for real, on temp repos.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ALLOW_RULES, claudeSettingsFile, missingAllowRules } from "../src/claude/permissions.js";
import { APP_SKILL, appSkillInstalled, appSkillSource, appSkillTarget, BOARD_SKILL, FLOW_SKILL, SETUP_SKILL } from "../src/claude/skill.js";
import type { DoctorCheck } from "../src/commands/doctor.js";
import { nextSteps, runInit, type InitDeps } from "../src/commands/init.js";
import { pickOption, type Asker } from "../src/core/ask.js";
import { planOf } from "../src/core/claude-bin.js";
import { DEFAULT_TEAM, loadPersonalConfig, loadTeamConfig, savePersonalConfig, type PersonalConfig, type TeamConfig } from "../src/core/config.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import type { State } from "../src/core/state.js";
import { mcpEntry } from "../src/mcp/server.js";
import { buildChecklist, type ChecklistInputs } from "../src/setup/checklist.js";
import { formatSetup, initYesLeft, restartNeeded, setupParts, setupPrompt, skillSteps } from "../src/setup/claude-setup.js";
import { runInstall, type InstallDeps } from "../src/setup/install.js";
import { freshHome, git, pmxRepo, quietOut, tmp } from "./helpers.js";

const LINEAR = { kind: "linear", teamKey: "ACME", projectId: "proj-1" } as const;

/** Every question init asks, in order, with scripted answers by a word in the question. Unanswered ones take their default. */
function recordingAsker(answers: Record<string, string | boolean> = {}) {
  const asked: { kind: "text" | "secret" | "confirm" | "choose"; q: string }[] = [];
  const find = (q: string) => Object.entries(answers).find(([k]) => q.toLowerCase().includes(k.toLowerCase()))?.[1];
  const ask: Asker = {
    async text(q, def = "") { asked.push({ kind: "text", q }); const a = find(q); return typeof a === "string" ? a : def; },
    async secret(q) { asked.push({ kind: "secret", q }); const a = find(q); return typeof a === "string" ? a : ""; },
    async confirm(q, def = true) { asked.push({ kind: "confirm", q }); const a = find(q); return typeof a === "boolean" ? a : def; },
    async choose(q, options, def) { asked.push({ kind: "choose", q }); const a = find(q); return (options.find((o) => o === a) ?? def) as any; },
  };
  return { ask, asked };
}

/**
 * This Mac's commands: Claude Code is installed and says which plan it's signed in with, `gh` is signed in or not,
 * git says whose email it has, npm packs nothing, and a GitHub URL clones the local stand-in (keeping the GitHub URL
 * as its remote, as a real clone would).
 */
function mac(o: { email?: string; gh?: boolean; plan?: string | null; profileSignedIn?: boolean; github?: { url: string; local: string } } = {}): Exec & { ran: string[][] } {
  const ran: string[][] = [];
  const run: Exec = async (cmd, args, opts) => {
    ran.push([cmd, ...args]);
    if (cmd === "claude" || cmd.endsWith("/claude")) {
      if (args[0] === "--version") return cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : { stdout: "", stderr: "ENOENT", code: 127 };
      if (args[0] === "auth" && args[1] === "status") {
        const own = opts?.env?.CLAUDE_CONFIG_DIR === paths.claudeProfile();
        const loggedIn = own ? o.profileSignedIn ?? true : true;
        return { stdout: JSON.stringify({ loggedIn, ...(loggedIn && o.plan !== null ? { subscriptionType: o.plan ?? "max" } : {}) }), stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "not faked", code: 1 };
    }
    if (cmd === "gh") return o.gh ? { stdout: "gho_stand-in\n", stderr: "", code: 0 } : { stdout: "", stderr: "not logged in", code: 1 };
    if (cmd === "npm") return { stdout: "", stderr: "npm is a stand-in here", code: 1 };
    if (cmd === "git" && args.join(" ") === "config --get user.email") return { stdout: `${o.email ?? "lee@acme.example"}\n`, stderr: "", code: 0 };
    if (cmd === "git" && args[0] === "clone" && o.github && args[2] === o.github.url) {
      const r = await exec("git", ["clone", "-q", "--", o.github.local, args[3]!]);
      if (r.code === 0) await exec("git", ["-C", args[3]!, "remote", "set-url", "origin", o.github.url]);
      return r;
    }
    if (cmd === "git") return exec(cmd, args, opts);
    return { stdout: "", stderr: `${cmd}: not faked`, code: 1 };
  };
  return Object.assign(run, { ran });
}

/** A fresh Mac: empty home, the Claude app and Claude Code present, nothing of PMX's in either. */
async function freshMac() {
  const pmx = await freshHome();
  const home = await tmp("user-home-");
  process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  await mkdir(join(pmx, "claude-desktop"), { recursive: true });
  process.env.USER = "lee";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) process.env[k] = "Test";
  for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) process.env[k] = "test@example.com";
  return { home, cwd: await tmp("somewhere-") };
}

/** The team lead's repo, shared: a team on Linear with its company domain set. Its URL is what a joining PM is given. */
async function teamRepo(team: Partial<TeamConfig> = {}) {
  const { origin } = await pmxRepo({ team: "acme", tracker: LINEAR, internalDomains: ["acme.example"], ...team }, { remote: true });
  return `file://${origin}`;
}

const base = (m: { home: string; cwd: string }, over: Partial<InitDeps> = {}): InitDeps => ({
  ask: recordingAsker().ask, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: mac(), out: quietOut(), now: () => new Date("2026-11-27T09:00:00Z"),
  cliPath: "/x/lib/node_modules/productmaxxing/dist/src/cli.js", login: async () => 0, home: m.home, cwd: m.cwd, ...over,
});

const skillsHere = async () => (await Promise.all([SETUP_SKILL, APP_SKILL, FLOW_SKILL, BOARD_SKILL].map(async (n) => ((await appSkillInstalled(n)) ? n : null)))).filter(Boolean);

describe("pmx init asks only what a person must answer (CLI-2)", () => {
  let m: Awaited<ReturnType<typeof freshMac>>;
  beforeEach(async () => { m = await freshMac(); });

  it("a PM joining a team on Linear is asked three things at most: where the team's repo is, one yes, and their Linear API key", async () => {
    const url = await teamRepo();
    const { ask, asked } = recordingAsker({ "team's PMX repo": url });
    const launchd = fakeLaunchd(), out = quietOut(), run = mac({ plan: "max" });
    const p = await runInit(base(m, { ask, launchd, out, exec: run }));

    // Exactly three questions: no GitHub token, since this team's repo isn't on GitHub, and the Linear API key last
    // (LINEAR-2, Founder 2026-11-27: a key is the default way to Linear). Return there means the Claude app instead.
    expect(asked.map((a) => a.kind)).toEqual(["text", "choose", "secret"]);
    expect(asked[2]!.q).toBe("Linear API key (Return to use the Claude app instead)");
    expect(asked[0]!.q).toMatch(/^Your team's PMX repo: its git URL, or the folder you cloned it to/);
    expect(asked[1]!.q).toMatch(/^Go ahead\? yes: save this and make those 4 changes\. pick: save it, and choose each change\. no: save nothing$/);

    // PMX cloned the repo for them, and worked the rest out: the handle from the Mac's account, the plan from Claude
    // Code's sign-in, every kind of work the team has, no cap of their own on a Claude plan, the team's company domain.
    expect(run.ran).toContainEqual(["git", "clone", "--", url, join(m.home, "pmx")]);
    expect(p).toMatchObject({ repoPath: join(m.home, "pmx"), handle: "lee", plan: "max", budget: { dailyUsd: null }, companyDomains: ["acme.example"], neverIngest: { people: [], channels: [], meetingTitles: [] }, digest: { slackDmUserId: null } });
    expect(p.categories).toEqual(Object.keys((await loadTeamConfig(p.repoPath)).categories));
    expect(p.categoriesOff).toEqual([]);
    expect(p.sources.transcriptDirs).toEqual([paths.transcripts()]);
    expect(await loadPersonalConfig()).toEqual(p);

    // The summary shows each of those, and the four changes together, each with what it changes and where.
    const said = out.lines.join("\n");
    expect(said).toMatch(/PMX will save this setup:[\s\S]*You +lee, max plan[\s\S]*Company +acme\.example/);
    expect(said).toContain("PMX worked out everything you weren't asked. To change any of it: pmx init --ask.");
    expect(said).toMatch(/With your yes, PMX also changes 4 things outside its own folder \(~\/\.pmx\):\n  1\. Background job +registers the launchd job com\.productmaxxing\.pmx \(.*LaunchAgents\/com\.productmaxxing\.pmx\.plist\), which runs `pmx tick` every 30 minutes[^\n]*\n  2\. Claude commands +adds \/pmx-setup, \/pmx-schedule, \/pmx-flow and \/pmx-board to your Claude app's own commands \([^)]*skills\)[^\n]*\n  3\. Allow rules +adds Bash\(pmx \*\), Read\(~\/\.pmx\/\*\*\), Edit\(~\/\.pmx\/\*\*\) to your Claude settings \([^)]*settings\.json\)[^\n]*\n  4\. PMX's server +adds PMX's server to the Claude desktop app's settings \([^)]*claude_desktop_config\.json\)/);

    // One yes made all four.
    expect(launchd.plist).toContain("<string>tick</string>");
    expect(await skillsHere()).toEqual([SETUP_SKILL, APP_SKILL, FLOW_SKILL, BOARD_SKILL]);
    expect(await missingAllowRules()).toEqual([]);
    expect(await mcpEntry()).toMatchObject({ args: ["/x/lib/node_modules/productmaxxing/dist/src/cli.js", "mcp"] });
  });

  it("with the repo named on the command line, or a clone PMX can see, the one yes and the Linear key are the only questions", async () => {
    const url = await teamRepo();
    const named = recordingAsker();
    const p = await runInit(base(m, { ask: named.ask, repo: url }));
    expect(named.asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(p.repoPath).toBe(join(m.home, "pmx"));

    // Another PM cloned the repo themselves and runs init inside it: PMX finds it there and says so.
    const other = await freshMac();
    const clone = join(other.cwd, "team");
    await git(other.cwd, "clone", "-q", url, clone);
    const found = recordingAsker(), out = quietOut();
    const q = await runInit(base(other, { ask: found.ask, cwd: clone, out }));
    expect(found.asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(q.repoPath).toBe(clone);
    expect(out.lines.join("\n")).toMatch(/Your team's PMX repo: .*team \(this folder is a clone of it\)\. For another, run pmx init --repo <folder or git URL>\./);
  });

  it("asks for a token only where the team's setup needs one and nothing on the Mac answers", async () => {
    const local = (await teamRepo()).replace(/^file:\/\//, "");
    const github = { url: "https://github.com/acme-co/pmx.git", local };
    // On GitHub, with gh signed in: PMX opens pull requests through gh, so no GitHub token is asked for. The one secret
    // is the Linear API key, which this team's setup needs and nothing on the Mac answers.
    const withGh = recordingAsker();
    await runInit(base(m, { ask: withGh.ask, repo: github.url, exec: mac({ gh: true, github }) }));
    expect(withGh.asked.map((a) => a.q.split(" (")[0])).toEqual(["Go ahead? yes: save this and make those 4 changes. pick: save it, and choose each change. no: save nothing", "Linear API key"]);

    // On GitHub, without gh: one more question, typed into PMX's own prompt and kept in the keychain only.
    const other = await freshMac();
    const noGh = recordingAsker({ "GitHub token": "ghp_stand-in" });
    const keychain = memoryKeychain();
    await runInit(base(other, { ask: noGh.ask, repo: github.url, exec: mac({ gh: false, github }), keychain }));
    expect(noGh.asked.map((a) => a.kind)).toEqual(["choose", "secret", "secret"]);
    expect(noGh.asked[1]!.q).toMatch(/^GitHub token for opening PRs/);
    expect(noGh.asked[2]!.q).toMatch(/^Linear API key/);
    expect(await keychain.get("github-token")).toBe("ghp_stand-in");
    expect(await readFile(paths.config(), "utf8")).not.toContain("ghp_stand-in");
  });

  it("asks for the company's domain only when neither the team's settings nor the PM's git email says", async () => {
    const url = await teamRepo({ internalDomains: [] });
    const known = recordingAsker();
    expect((await runInit(base(m, { ask: known.ask, repo: url, exec: mac({ email: "lee@acme.example" }) }))).companyDomains).toEqual(["acme.example"]);
    expect(known.asked.map((a) => a.kind)).toEqual(["choose", "secret"]);

    const other = await freshMac();
    const unknown = recordingAsker({ "email domains": "acme.example" });
    expect((await runInit(base(other, { ask: unknown.ask, repo: url, exec: mac({ email: "lee@gmail.com" }) }))).companyDomains).toEqual(["acme.example"]);
    expect(unknown.asked.map((a) => a.kind)).toEqual(["text", "choose", "secret"]);
    expect(unknown.asked[0]!.q).toMatch(/^Your company's email domains/);
  });

  it("a team lead starting a team is asked six things: the repo, the team's name, its Linear team and project, one yes, and their Linear API key", async () => {
    const { ask, asked } = recordingAsker({ "Team name": "acme", "Linear team key": "https://linear.app/acme/team/ACME/all", "PMX project ID": "proj-1" });
    const out = quietOut();
    const p = await runInit(base(m, { ask, out }));
    expect(asked.map((a) => a.q.split(/[:,(?]/)[0]!.trim())).toEqual(["Your team's PMX repo", "Team name", "Linear team key", "Linear PMX project ID or link", "Go ahead", "Linear API key"]);
    // Blank at the first question: a new repo in ~/pmx, made and committed without two more questions, since the folder is PMX's own.
    expect(p.repoPath).toBe(join(m.home, "pmx"));
    expect(await loadTeamConfig(p.repoPath)).toMatchObject({ team: "acme", tracker: LINEAR, internalDomains: ["acme.example"], synthesizer: "lee" });
    expect(await git(p.repoPath, "log", "--format=%s")).toBe("Set up PMX repo with ProductMaxxing");
    expect(await git(p.repoPath, "status", "--short")).toBe("");
    expect(out.lines.join("\n")).toMatch(/Synthesis Mac {2}this one \(lee\), as your team's first/);

    // A lead who made an empty repo for the team first gives its URL: PMX clones it and sets it up there, with no more
    // questions than that (no Linear yet, so no project either). Pushing it stays theirs.
    const other = await freshMac();
    const empty = join(await tmp("remote-"), "team.git");
    await exec("git", ["init", "-q", "--bare", "-b", "main", empty]);
    const lead = recordingAsker({ "Team name": "acme" });
    const q = await runInit(base(other, { ask: lead.ask, repo: `file://${empty}` }));
    expect(lead.asked.map((a) => a.q.split(/[:,(?]/)[0]!.trim())).toEqual(["Team name", "Linear team key", "Go ahead"]);
    expect(q.repoPath).toBe(join(other.home, "pmx"));
    expect(await git(q.repoPath, "log", "--format=%s")).toBe("Set up PMX repo with ProductMaxxing");
    expect(await git(q.repoPath, "remote", "get-url", "origin")).toBe(`file://${empty}`);
    expect((await exec("git", ["--git-dir", empty, "log", "--oneline"])).stdout).toBe("");
  });

  it("asks before it sets up a folder that already holds something, and before it commits there", async () => {
    const mine = join(m.home, "notes");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "plan.txt"), "mine");
    const { ask, asked } = recordingAsker({ "Set it up as a new PMX repo": true, "Team name": "acme", "Commit the PMX repo setup": false });
    await runInit(base(m, { ask, repo: mine }));
    expect(asked[0]!.q).toMatch(/notes has no pmx\.config\.json, and it already holds files\. Set it up as a new PMX repo\?$/);
    expect(asked.slice(1).map((a) => a.q.split(/[:,(?.]/)[0]!.trim())).toEqual(["Team name", "Linear team key", "Go ahead", "Commit the PMX repo setup now"]);
    // Declined: PMX's files are there, and nothing of the PM's was committed.
    expect(await git(mine, "status", "--short")).toContain("?? plan.txt");
  });

  it("leaves a folder that holds something alone unless the yes is typed: Return and a run nobody answers are not a yes", async () => {
    const mine = join(m.home, "notes");
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, "plan.txt"), "mine");
    await expect(runInit(base(m, { repo: mine }))).rejects.toThrow(/notes has none\..*Run pmx init again and answer yes\. Nothing was saved\./);
    expect(await readdir(mine)).toEqual(["plan.txt"]);
    await expect(loadPersonalConfig()).rejects.toThrow(/Not set up/);
  });

  it("clones a bare repo, the copy a team clones from, and never writes in it", async () => {
    const bare = (await teamRepo()).replace("file://", "");
    const before = { files: (await readdir(bare)).sort(), main: await git(bare, "rev-parse", "main"), refs: await git(bare, "for-each-ref") };
    // Every default taken, as `pmx init --repo <path> --yes` would.
    const p = await runInit(base(m, { repo: bare }));
    expect(p.repoPath).toBe(join(m.home, "pmx"));
    expect((await loadTeamConfig(p.repoPath)).team).toBe("acme");
    expect(await git(p.repoPath, "config", "--get", "remote.origin.url")).toBe(bare);
    expect({ files: (await readdir(bare)).sort(), main: await git(bare, "rev-parse", "main"), refs: await git(bare, "for-each-ref") }).toEqual(before);
    // Again, with that clone in place: the same clone, and the bare repo still as it was.
    expect((await runInit(base(m, { repo: bare }))).repoPath).toBe(join(m.home, "pmx"));
    expect((await readdir(bare)).sort()).toEqual(before.files);
  });

  it("never sets a team up inside a bare repo, whichever way init is asked", async () => {
    // An empty bare repo: nothing in it says PMX. A new team's repo is set up in a clone of it, not in it.
    const empty = join(await tmp("bare-"), "team.git");
    await exec("git", ["init", "-q", "--bare", "-b", "main", empty]);
    const before = (await readdir(empty)).sort();
    const p = await runInit(base(m, { ask: recordingAsker({ "Team name": "acme", "Commit the PMX repo setup": false }).ask, repo: empty }));
    expect(p.repoPath).toBe(join(m.home, "pmx"));
    expect((await readdir(empty)).sort()).toEqual(before);
    // --ask, where the first question is a checkout's folder: a bare repo is refused there with why.
    const m2 = await freshMac();
    const { ask, asked } = recordingAsker({ "Path to your team's PMX repo checkout": empty });
    await expect(runInit(base(m2, { ask, askAll: true }))).rejects.toThrow(/Nothing was saved/);
    expect(asked.every((a) => /Path to your team's PMX repo checkout/.test(a.q))).toBe(true);
    expect((await readdir(empty)).sort()).toEqual(before);
  });
});

describe("one yes for the four changes outside ~/.pmx (INIT-1)", () => {
  let m: Awaited<ReturnType<typeof freshMac>>;
  beforeEach(async () => { m = await freshMac(); });

  it("pick applies only the ones chosen, and init still finishes", async () => {
    const url = await teamRepo();
    const { ask, asked } = recordingAsker({ "Go ahead": "pick", "background job": true, "to your Claude app": false, "without asking each time": true, "pmx-flow board": false });
    const launchd = fakeLaunchd();
    const p = await runInit(base(m, { ask, launchd, repo: url }));
    // The one question, then each change by itself, in the order they were listed.
    expect(asked.map((a) => a.q.split(/[?(]/)[0]!.trim())).toEqual([
      "Go ahead", "Linear API key", "Register the background job", "Add /pmx-setup, /pmx-schedule, /pmx-flow and /pmx-board to your Claude app, so Claude can finish PMX's setup in one chat: its scheduled tasks, its page and your team's live board",
      "Let PMX's scheduled tasks run pmx and use ~/.pmx without asking each time", "Let your /pmx-flow board in the Claude app read PMX on this Mac",
    ]);
    expect(launchd.plist).toContain("<string>tick</string>");
    expect(await missingAllowRules()).toEqual([]);
    expect(await skillsHere()).toEqual([]);
    expect(await mcpEntry()).toBeNull();
    expect(await loadPersonalConfig()).toEqual(p);
  });

  it("declining every one still sets PMX up, as before; no saves nothing and changes nothing", async () => {
    const url = await teamRepo();
    const none = recordingAsker({ "Go ahead": "pick", "background job": false, "to your Claude app": false, "without asking each time": false, "pmx-flow board": false });
    const launchd = fakeLaunchd();
    await runInit(base(m, { ask: none.ask, launchd, repo: url }));
    expect(launchd.plist).toBeNull();
    expect(await skillsHere()).toEqual([]);
    expect(await missingAllowRules()).toEqual([...ALLOW_RULES]);
    expect(await mcpEntry()).toBeNull();
    expect((await loadPersonalConfig()).handle).toBe("lee");
    // Running it again offers the same four: nothing was remembered as refused.
    const again = recordingAsker({ "Go ahead": "no" });
    await expect(runInit(base(m, { ask: again.ask, launchd }))).rejects.toThrow(/Nothing was saved, and nothing on this Mac was changed/);
    expect(again.asked.map((a) => a.q)).toEqual(["Go ahead? yes: save this and make those 4 changes. pick: save it, and choose each change. no: save nothing"]);

    const other = await freshMac();
    const no = recordingAsker({ "Go ahead": "no" });
    const untouched = fakeLaunchd();
    await expect(runInit(base(other, { ask: no.ask, launchd: untouched, repo: url }))).rejects.toThrow(/Nothing was saved/);
    expect(await stat(paths.config()).catch(() => null)).toBeNull();
    expect(untouched.plist).toBeNull();
    expect(await skillsHere()).toEqual([]);
    expect(await stat(claudeSettingsFile()).catch(() => null)).toBeNull();
    expect(await mcpEntry()).toBeNull();
  });

  it("lists only what this Mac lacks: no desktop app means no server entry, no Linear means no board command", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(process.env.PMX_HOME!, "claude-desktop"), { recursive: true });
    const url = await teamRepo({ tracker: { kind: "none" } });
    const { ask, asked } = recordingAsker();
    const out = quietOut();
    await runInit(base(m, { ask, out, repo: url }));
    expect(asked.map((a) => a.q)).toEqual(["Go ahead? yes: save this and make those 3 changes. pick: save it, and choose each change. no: save nothing"]);
    expect(out.lines.join("\n")).toMatch(/2\. Claude commands +adds \/pmx-setup, \/pmx-schedule and \/pmx-flow to your Claude app's own commands/);
    expect(out.lines.join("\n")).not.toMatch(/PMX's server +adds/);
    expect(await skillsHere()).toEqual([SETUP_SKILL, APP_SKILL, FLOW_SKILL]);
    expect(await mcpEntry()).toBeNull();
  });

  it("where nobody can answer, it makes none of them and opens no browser: a default is not a yes", async () => {
    const url = await teamRepo();
    const { ask, asked } = recordingAsker();
    const launchd = fakeLaunchd(), out = quietOut();
    let logins = 0;
    const p = await runInit(base(m, { ask, launchd, out, repo: url, unattended: true, exec: mac({ profileSignedIn: false }), login: async () => (logins++, 0) }));
    expect(asked).toEqual([]);
    expect(launchd.plist).toBeNull();
    expect(await skillsHere()).toEqual([]);
    expect(await stat(claudeSettingsFile()).catch(() => null)).toBeNull();
    expect(await mcpEntry()).toBeNull();
    expect(logins).toBe(0);
    expect(await loadPersonalConfig()).toEqual(p);
    expect(out.lines.join("\n")).toMatch(/WARN Nobody can answer here \(no terminal, and no --yes\), so PMX changes nothing outside its own folder: none of the 4 changes above\. Run `pmx init` in Terminal to say yes\./);
    expect(out.lines.join("\n")).toMatch(/WARN Nobody is here to sign in, so agent runs fail until you run `pmx claude login` in Terminal\./);
    // --ask without a terminal: its questions take their defaults, and still nothing outside ~/.pmx changes.
    const other = await freshMac();
    const untouched = fakeLaunchd();
    await runInit(base(other, { askAll: true, unattended: true, launchd: untouched, ask: recordingAsker({ "PMX repo checkout": join(other.home, "pmx"), "Git URL": url }).ask }));
    expect(untouched.plist).toBeNull();
    expect(await skillsHere()).toEqual([]);
    expect(await mcpEntry()).toBeNull();
  });

  it("signs in PMX's own Claude profile after the yes, which the summary said it would, without another question", async () => {
    const url = await teamRepo();
    const { ask, asked } = recordingAsker();
    const out = quietOut();
    let logins = 0;
    await runInit(base(m, { ask, out, repo: url, exec: mac({ profileSignedIn: false }), login: async () => (logins++, 0) }));
    // The sign-in adds no question of its own (the Linear key is the team's, asked either way).
    expect(asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(logins).toBe(1);
    expect(out.lines.join("\n")).toMatch(/Then your browser opens once, to sign in PMX's own Claude profile \(~\/\.pmx\/claude\)/);
    // After a no, nothing opens.
    const other = await freshMac();
    await expect(runInit(base(other, { ask: recordingAsker({ "Go ahead": "no" }).ask, repo: url, exec: mac({ profileSignedIn: false }), login: async () => (logins++, 0) }))).rejects.toThrow(/Nothing was saved/);
    expect(logins).toBe(1);
  });
});

describe("pmx init --ask, and running init again", () => {
  let m: Awaited<ReturnType<typeof freshMac>>;
  beforeEach(async () => { m = await freshMac(); });

  it("--ask asks everything, each with what PMX worked out as its default", async () => {
    const url = await teamRepo();
    const { ask, asked } = recordingAsker({ "PMX repo checkout": join(m.home, "pmx"), "Git URL": url });
    const p = await runInit(base(m, { ask, askAll: true, exec: mac({ profileSignedIn: false }) }));
    expect(asked.map((a) => a.q.split(/[?(]/)[0]!.trim().split(":")[0])).toEqual([
      "Path to your team's PMX repo checkout", "No git repo there. Git URL of your team's PMX repo", "Your handle", "Model plan for runs", "Categories your agent accepts",
      "Daily cap on PMX's usage, in USD at API list prices", "Your company's email domains, like acme.com", "Folders with call transcripts to include",
      "Never ingest anything involving these people", "Never ingest meetings whose titles contain", "Never ingest these channels", "Save this setup",
      "Linear API key", "Sign in PMX's Claude profile now", "Register the background job",
      "Add /pmx-setup, /pmx-schedule, /pmx-flow and /pmx-board to your Claude app, so Claude can finish PMX's setup in one chat",
      "Let PMX's scheduled tasks run pmx and use ~/.pmx without asking each time", "Let your /pmx-flow board in the Claude app read PMX on this Mac",
    ]);
    expect(asked).toHaveLength(18);
    // Its defaults are the short path's answers, so pressing Return through it gives the same setup.
    expect(p).toMatchObject({ handle: "lee", plan: "team", companyDomains: ["acme.example"] });
  });

  it("running it again asks nothing and changes nothing", async () => {
    const url = await teamRepo();
    const launchd = fakeLaunchd();
    await runInit(base(m, { launchd, repo: url }));
    // Things PMX saved since: the page's link, the PM's hours and who they are in a transcript.
    const saved = await loadPersonalConfig();
    await savePersonalConfig({ ...saved, taskHours: "weekdays", flow: { url: "https://claude.ai/artifact/abc", version: "0.40.3", publishedAt: "2026-11-27T10:00:00.000Z" }, identity: { names: ["Lee"], emails: ["lee@acme.example"] } } as PersonalConfig);
    const snapshot = async () => ({
      config: await readFile(paths.config(), "utf8"), job: launchd.plist, settings: await readFile(claudeSettingsFile(), "utf8"),
      desktop: await readFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, "utf8"), skill: await readFile(appSkillTarget(SETUP_SKILL), "utf8"),
      repo: await git(join(m.home, "pmx"), "status", "--short"), head: await git(join(m.home, "pmx"), "rev-parse", "HEAD"), home: (await readdir(m.home)).sort(),
    });
    const before = await snapshot();
    let installs = 0;
    const watched = { ...launchd, install: async (p: string) => { installs++; await launchd.install(p); } };

    const { ask, asked } = recordingAsker();
    const out = quietOut();
    const p = await runInit(base(m, { ask, out, launchd: watched, now: () => new Date("2026-12-01T09:00:00Z") }));
    expect(asked).toEqual([]);
    expect(installs).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(p).toMatchObject({ taskHours: "weekdays", flow: { url: "https://claude.ai/artifact/abc" }, identity: { names: ["Lee"] }, installedAt: saved.installedAt });
    expect(out.lines.join("\n")).toMatch(/PMX is set up on this Mac as lee, with team "acme" in .*pmx\. Nothing to change: pmx init --ask goes through every answer\./);
    expect(out.lines.join("\n")).not.toContain("PMX will save this setup");
  });

  it("a rerun leaves every saved setting as it is, byte for byte, whatever an older pmx or PMX's page saved there", async () => {
    const url = await teamRepo();
    const repo = join(m.home, "pmx");
    await git(m.home, "clone", "-q", url, repo);
    const notes = await tmp("notes-");
    // Not one default among them, a kind the team no longer has, a setting this pmx doesn't know, and a layout of its own.
    const rich = {
      futureSetting: { keep: ["me"] },
      digest: { slackDmUserId: "U012AB3CD", weekday: 2 },
      version: 1, handle: "lee-r", machineId: "m0a1b2c3d", repoPath: repo, installedAt: "2026-03-04T05:06:07.000Z", plan: "enterprise",
      categories: ["spec", "problem-brief", "a-kind-the-team-dropped"], categoriesOff: ["decision-brief", "another-dropped-kind"],
      workingHours: { days: [1, 2, 3, 4, 5], start: "00:00", end: "23:59" },
      budget: { overrideUsd: 25, resetHour: 4, dailyUsd: 7.5 },
      companyDomains: ["acme.example", "us.acme.example"],
      sources: { slackChannel: "C012AB3CD", routes: { granola: "mine", file: "off" }, calls: [{ connector: "momentum", look: null }], transcriptDirs: [join(notes, "calls"), join(notes, "more")] },
      neverIngest: { meetingTitles: ["1:1"], channels: ["#deals"], people: ["Sam Roe", "sam@other.example"] },
      crmNamesFile: join(notes, "crm.txt"),
      cloud: { url: "https://cloud.example", orgId: "org_1" }, analytics: { enabled: true, decidedAt: "2026-03-05T00:00:00.000Z" },
      identity: { names: ["Lee R"], emails: ["lee@us.acme.example"] },
      board: { url: "https://claude.ai/artifact/board1", version: "0.38.0", publishedAt: "2026-11-01T00:00:00.000Z", template: "abc123" },
      flow: { url: "https://claude.ai/artifact/flow1", version: "0.36.0", publishedAt: "2026-11-02T00:00:00.000Z" },
      todosToLinear: true, taskHours: "weekdays", studio: "hidden",
    };
    const bytes = `${JSON.stringify(rich, null, 4)}`; // four spaces and no last newline: any rewrite at all would show
    const { mkdir: mk, chmod } = await import("node:fs/promises");
    await mk(process.env.PMX_HOME!, { recursive: true });
    await writeFile(paths.config(), bytes);
    await chmod(paths.config(), 0o600);
    const same = async () => expect(await readFile(paths.config(), "utf8")).toBe(bytes);

    // A home with its settings and nothing else of PMX's on the Mac: one yes makes the four changes, and the settings stay.
    const first = recordingAsker();
    const launchd = fakeLaunchd();
    const p = await runInit(base(m, { ask: first.ask, launchd }));
    // The one yes, and (LINEAR-2) the Linear API key this Mac was never asked for. Return is remembered beside the
    // settings, in ~/.pmx/state.json, so the settings file itself stays as it is and the next run doesn't ask again.
    expect(first.asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(launchd.plist).toContain("<string>tick</string>");
    await same();
    expect(p).toEqual(rich);
    // Again, with everything in place: nothing asked, nothing written.
    const quiet = recordingAsker();
    await runInit(base(m, { ask: quiet.ask, launchd, now: () => new Date("2027-01-01T00:00:00Z") }));
    expect(quiet.asked).toEqual([]);
    await same();
    // Nobody at the keyboard, and the person saying no: the same.
    await runInit(base(m, { launchd: fakeLaunchd(), unattended: true }));
    await same();
    await expect(runInit(base(m, { launchd: fakeLaunchd(), ask: recordingAsker({ "Go ahead": "no" }).ask }))).rejects.toThrow(/Nothing was saved/);
    await same();

    // --ask with Return at every question changes only what its answers say: here the transcript folders and domains read
    // back as they were, so even then the settings PMX never asks about are untouched.
    const all = await runInit(base(m, { askAll: true, launchd, ask: recordingAsker({ "PMX repo checkout": repo, "Categories your agent accepts": "spec, problem-brief" }).ask }));
    expect(all).toMatchObject({ workingHours: rich.workingHours, budget: rich.budget, taskHours: "weekdays", todosToLinear: true, futureSetting: rich.futureSetting, crmNamesFile: rich.crmNamesFile, machineId: rich.machineId, installedAt: rich.installedAt, flow: rich.flow, board: rich.board, identity: rich.identity, cloud: rich.cloud, analytics: rich.analytics, studio: "hidden" });
    expect(all.sources).toEqual(rich.sources);
    expect(all.neverIngest).toEqual(rich.neverIngest);
    expect(all.digest).toEqual(rich.digest);
    // The one thing answered differently, and what follows from it.
    expect(all.categories).toEqual(["spec", "problem-brief"]);
    expect(all.categoriesOff).toEqual(expect.arrayContaining(["another-dropped-kind", "decision-brief", "research-synthesis"]));
  });

  it("a later run offers only what's still missing, and keeps a kind of work the team added since for the PM to choose", async () => {
    const url = await teamRepo();
    const launchd = fakeLaunchd();
    const first = recordingAsker({ "Go ahead": "pick", "pmx-flow board": false });
    await runInit(base(m, { ask: first.ask, launchd, repo: url }));
    expect(await mcpEntry()).toBeNull();
    // The team adds a kind of work; the PM runs init again.
    const repo = join(m.home, "pmx");
    const cfg = JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8"));
    cfg.categories = { ...DEFAULT_TEAM.categories, ...cfg.categories, "launch-note": { skill: "launch-note" } };
    await writeFile(join(repo, "pmx.config.json"), JSON.stringify(cfg, null, 2));
    const { ask, asked } = recordingAsker();
    const out = quietOut();
    const p = await runInit(base(m, { ask, out, launchd }));
    expect(asked.map((a) => a.q)).toEqual(["Go ahead? yes: save this and make that change. pick: save it, and choose about the change. no: save nothing"]);
    expect(out.lines.join("\n")).toMatch(/PMX also changes 1 thing outside its own folder \(~\/\.pmx\):\n  1\. PMX's server/);
    expect(await mcpEntry()).not.toBeNull();
    // Not asked about, so not chosen: the new kind is in neither list, and Needs you still asks.
    expect(p.categories).not.toContain("launch-note");
    expect(p.categoriesOff).toEqual([]);
  });

  it("typing y, p or n at a choice works, and a plan is read from Claude Code's sign-in only when it says one", () => {
    expect([pickOption(["yes", "pick", "no"], "y"), pickOption(["yes", "pick", "no"], "P"), pickOption(["yes", "pick", "no"], "no"), pickOption(["yes", "pick", "no"], "maybe"), pickOption(["pro", "pick"], "p")]).toEqual(["yes", "pick", "no", undefined, undefined]);
    expect([planOf({ loggedIn: true, subscriptionType: "max" }), planOf({ loggedIn: true, apiProvider: "bedrock" }), planOf({ loggedIn: true, authMethod: "api_key" }), planOf({ loggedIn: true }), planOf({ loggedIn: false, subscriptionType: "max" }), planOf("2.1.300")])
      .toEqual(["max", "bedrock", "api", null, null, null]);
  });
});

// ---- One chat in the Claude app

const NOW = new Date("2026-11-27T09:30:00Z");
const ok = (id: string, detail = id): DoctorCheck => ({ id, ok: true, detail, level: "fail" });
const warn = (id: string, detail: string): DoctorCheck => ({ id, ok: false, detail, level: "warn" });
const BASE_CHECKS = [
  ok("os.macos"), ok("node", "Node 24.1.0"), ok("claude.installed", "Claude Code 2.1"), ok("cli.team-minimum"), ok("profile.signed-in", "signed in"),
  ok("config.personal"), ok("config.team", "pmx.config.json valid (team acme)"), ok("privacy.company-domains", "company domains acme.example"), ok("privacy.canaries", "all test meetings held"),
  ok("schedule.launchd", "launchd job loaded"), ok("schedule.tick", "last pass ok"), ok("claude.allow", "allow rules present"), ok("flow.mcp", "the Claude app can start PMX's server"),
];
/** Right after `pmx init` with its one yes: nothing in the Claude app yet. */
const AFTER_INIT = [
  ...BASE_CHECKS,
  warn("claude.task.pmx-collect-meetings", 'Claude scheduled task "PMX: collect meetings and update to-dos" is missing: type /pmx-schedule'),
  warn("claude.task.pmx-sync-linear", 'Claude scheduled task "PMX: sync Linear through Claude" is missing: type /pmx-schedule'),
  warn("claude.board", "no Claude board yet: type /pmx-board in the Claude app"), warn("linear.relay", "Linear through Claude: not synced yet"),
];
const PERSON = { handle: "lee", repoPath: "/Users/lee/pmx", installedAt: "2026-11-27T09:00:00Z", categories: [], budget: { dailyUsd: null, resetHour: 0 }, sources: { transcriptDirs: ["/Users/lee/.pmx/transcripts"], slackChannel: null } } as unknown as PersonalConfig;
const checklist = (o: Partial<ChecklistInputs> = {}) => buildChecklist({
  now: NOW, version: "0.41.0", personal: PERSON, team: { ...DEFAULT_TEAM, team: "acme", tracker: LINEAR } as TeamConfig, checks: AFTER_INIT,
  state: { lastTick: { at: "2026-11-27T09:20:00Z", failed: [], failStreak: 0 }, collectReports: [], tickGaps: [], taskRuns: {} } as unknown as State, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null,
  practiceUntil: "2026-12-04T09:00:00Z", lastRun: null, setupSkill: "current", linearCron: null, linearTaskMissing: true, engine: null, extra: [],
  appSkills: { flow: true, board: true }, mcpRegistered: true, ...o,
});
const APP = { desktopApp: true, mcpRegistered: true, serverRunning: true };

describe("one /pmx-setup chat does the Claude app's part (SETUP-1)", () => {
  beforeEach(freshHome);

  it("covers the tasks, the page and the board, in that order, each with its own command's steps", async () => {
    const text = await setupPrompt(checklist(), APP);
    const at = (s: string) => { const i = text.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const order = [
      at("## Part 1 of 3: PMX's scheduled tasks (to do: missing: PMX: collect meetings and update to-dos, PMX: sync Linear through Claude)"), at("pmx schedule --json"),
      at("## Part 2 of 3: PMX's page in Claude (to do: not published yet."), at("pmx flow --publish-json"), at("pmx flow --set-url"),
      at("## Part 3 of 3: your team's board (to do: no Claude board yet"), at("pmx board --json"), at("pmx board --set-url"),
      at("## Last: what's left for the person"),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // One source: each part is that command's own skill file, word for word, so nothing is written twice.
    for (const name of [APP_SKILL, FLOW_SKILL, BOARD_SKILL] as const) {
      const steps = await skillSteps(name);
      expect(steps).toMatch(/^\S/);
      expect(steps).not.toMatch(/^---|Installed by ProductMaxxing|^# /);
      expect((await readFile(appSkillSource(name), "utf8")).endsWith(`${steps}\n`)).toBe(true);
      expect(text).toContain(steps);
    }
    // It ends with exactly what's left for the person: the first run of each task. The app already runs PMX's server, so no restart.
    const last = text.slice(at("## Last: what's left for the person"));
    expect(last).toMatch(/\n1\. For each scheduled task you created or updated: in the Claude app, Code tab → Scheduled → the task → Run now, once, and choose Always allow/);
    expect(last).toContain("No restart is needed: the Claude app already runs PMX's server. Don't ask for one.");
    expect(last).not.toMatch(/Quit the Claude app/);
    expect(text).toContain("Never ask the user to quit or restart the Claude app before the last part.");
  });

  it("asks for the restart once, last, and only when PMX's server is new to the app", async () => {
    // `pmx init` added the entry and the app hasn't been reopened since: no server is running.
    const fresh = await setupPrompt(checklist(), { ...APP, serverRunning: false });
    const last = fresh.slice(fresh.indexOf("## Last"));
    // The restart is the last item on the list, after everything else that's theirs.
    expect(last).toMatch(/\n5\. Quit the Claude app completely \(⌘Q, not just its window\) and open it again, once: PMX's server is new in the app's settings[^\n]*Say this one last\.\nAfter the list:/);
    expect(fresh.match(/Quit the Claude app completely/g)).toHaveLength(1);
    expect(last.indexOf("Run now")).toBeLessThan(last.indexOf("Quit the Claude app"));
    expect(restartNeeded({ ...APP, serverRunning: false })).toBe("yes");

    // The PM said no to the server at init: the chat offers it before the page, and restarts only if it was added.
    const none = await setupPrompt(checklist({ checks: AFTER_INIT.filter((c) => c.id !== "flow.mcp"), mcpRegistered: false }), { desktopApp: true, mcpRegistered: false, serverRunning: false });
    const page = none.slice(none.indexOf("## Part 2"), none.indexOf("## Part 3"));
    expect(page).toMatch(/Before step 1: PMX's server isn't in the Claude app's settings yet[^\n]*Ask the user: "May I add PMX's server to the Claude desktop app's settings[^\n]*On yes, run `pmx mcp --install --yes`\.[^\n]*the restart waits for the last part\./);
    expect(page.indexOf("Before step 1")).toBeLessThan(page.indexOf("pmx flow --publish-json"));
    expect(none.slice(none.indexOf("## Last"))).toMatch(/Only if you added PMX's server in this chat: quit the Claude app completely/);
    // No desktop app on this Mac (Claude Code only): nothing to restart.
    expect(restartNeeded({ desktopApp: false, mcpRegistered: false, serverRunning: false })).toBe("no");
  });

  it("skips what this Mac already has, by the checklist", async () => {
    // The tasks exist and ran, the team shares a board, and only the page is missing.
    const checks = [...BASE_CHECKS, ok("claude.task.pmx-collect-meetings", 'Claude scheduled task "PMX: collect meetings and update to-dos"'), ok("claude.task.pmx-sync-linear", 'Claude scheduled task "PMX: sync Linear through Claude"'), ok("claude.board", "team board https://claude.ai/artifact/b"), ok("linear.relay", "Linear through Claude: last synced 20 min ago")];
    const cl = checklist({ checks, linearTaskMissing: false });
    expect(setupParts(cl).map((p) => [p.id, p.state])).toEqual([["tasks", "done"], ["page", "do"], ["board", "done"]]);
    const text = await setupPrompt(cl, APP);
    expect(text).toMatch(/## Part 1 of 3: PMX's scheduled tasks \(done: 2 tasks set up and running\)\nNothing to do here\./);
    expect(text).toMatch(/## Part 3 of 3: your team's board \(done: team board https:\/\/claude\.ai\/artifact\/b\)\nNothing to do here\./);
    expect(text).not.toContain("pmx schedule --json");
    expect(text).not.toContain("pmx board --json");
    expect(text).toContain("pmx flow --publish-json");
    expect(text.slice(text.indexOf("## Last"))).not.toMatch(/Run now/);

    // A team without Linear has no board, and a task whose run waits for an approval is the person's to finish.
    const waiting = checklist({ team: { ...DEFAULT_TEAM, team: "acme" } as TeamConfig, checks: [...checks.filter((c) => !/board|linear/.test(c.id)), warn("claude.task.pmx-collect-meetings.ran", '"PMX: collect meetings and update to-dos" last run started 2h ago and didn\'t finish')] });
    expect(setupParts(waiting).map((p) => [p.id, p.state])).toEqual([["tasks", "done"], ["page", "do"], ["board", "skip"]]);
    const t = await setupPrompt(waiting, APP);
    expect(t).toMatch(/## Part 3 of 3: your team's board \(not needed: only for teams on Linear\)\nThis Mac doesn't need it\./);
    expect(t.slice(t.indexOf("## Last"))).toMatch(/\n1\. "PMX: collect meetings and update to-dos" last run started 2h ago and didn't finish\. In the Claude app: Code tab → Scheduled → the task → its last run → Always allow/);
  });

  it("when setup's one question never got its yes, the checklist, the prompt and Terminal all say: run pmx init and answer it", async () => {
    // `pmx init` ran with nobody to answer (or the person said no): settings saved, no job, and nothing of PMX's in the Claude app.
    const noYes = [ok("os.macos"), ok("node", "Node 24.1.0"), ok("claude.installed", "Claude Code 2.1"), ok("cli.team-minimum"), ok("profile.signed-in", "signed in"),
      ok("config.personal"), ok("config.team", "pmx.config.json valid (team acme)"), ok("privacy.company-domains", "company domains acme.example"), ok("privacy.canaries", "all test meetings held"),
      { id: "schedule.launchd", ok: false, detail: "no background job on this Mac, so nothing runs by itself: run `pmx init`", level: "fail" as const }];
    const cl = checklist({ checks: noYes, claude: false, appSkills: undefined, mcpRegistered: false, setupSkill: "missing", state: { collectReports: [], tickGaps: [], taskRuns: {} } as unknown as State });
    const NONE = { desktopApp: true, mcpRegistered: false, serverRunning: false };

    // The checklist's next step is that, in so many words, and the Claude app's part is a step to do, not one that doesn't apply.
    expect(cl.next).toMatchObject({ id: "job.installed", who: "you", how: "terminal", required: true });
    expect(cl.next!.do).toMatch(/^Run pmx init in Terminal and answer its one question: one yes registers the background job and adds whatever else of PMX's this Mac still lacks in the Claude app$/);
    const claude = cl.sections.find((s) => s.id === "claude")!.steps;
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ id: "claude.setup", status: "todo", required: true, do: cl.next!.do, fix: { kind: "pmx", label: "Add /pmx-setup" } });
    expect(claude[0]!.detail).toMatch(/^PMX has added nothing to the Claude app on this Mac yet, because setup's one question hasn't had a yes/);
    expect(cl.where).toMatch(/required steps are left before it can do its job: The background job runs PMX every 30 minutes; PMX is in the Claude app[;.]/);

    // The prompt never says "not needed" or "This Mac doesn't need it" for parts it couldn't look at, and its list starts with pmx init.
    expect(setupParts(cl).map((p) => p.state)).toEqual(["wait", "wait", "wait"]);
    expect(initYesLeft(cl, NONE)).toEqual({ must: true, lacks: ["the background job", "PMX's commands and always-allow rules in the Claude app", "PMX's server in the Claude app's settings"] });
    const text = await setupPrompt(cl, NONE);
    expect(text).not.toMatch(/\(not needed|This Mac doesn't need it|after pmx init\)/);
    expect(text).toMatch(/## Part 1 of 3: PMX's scheduled tasks \(waits for pmx init: PMX has added nothing to the Claude app on this Mac yet\)\nNot in this chat: the user runs `pmx init` first \(the last part says how\), then types \/pmx-setup again\./);
    const last = text.slice(text.indexOf("## Last"));
    expect(last).toMatch(/\n1\. Run `pmx init` in Terminal and answer its one question\. Setup's one question hasn't had a yes on this Mac, so PMX still lacks the background job, PMX's commands and always-allow rules in the Claude app and PMX's server in the Claude app's settings; one yes there makes them all, and nothing runs by itself until then\. Only the user can give that yes: don't run `pmx init` for them\. Afterwards they quit the Claude app completely \(⌘Q\), open it again and type \/pmx-setup: this chat then does the parts above\.\nAfter the list:/);
    expect(formatSetup(cl, NONE)).toMatch(/\nFirst: run pmx init and answer its one question\. It hasn't had a yes on this Mac, so PMX still lacks the background job, [^\n]*; one yes makes them all\.\nThen quit the Claude app \(⌘Q\), open it again, and type \/pmx-setup in its Code tab: one chat does the rest\.$/);
    // And so does what `pmx init` itself prints last after such a run.
    const next = await nextSteps({ ...DEFAULT_TEAM, team: "acme", tracker: LINEAR } as TeamConfig, PERSON, NONE, initYesLeft(cl, NONE));
    expect(next.split("\n")[1]).toMatch(/^  1\. Run `pmx init` again in Terminal and answer its one question\. PMX still lacks the background job, [^.]* on this Mac, and one yes makes them all\. Nothing runs by itself until then\.$/);

    // The person picked the Claude changes and left the job out: the parts are done in the chat, and the job is still theirs, first.
    const jobless = checklist({ checks: [...AFTER_INIT.filter((c) => c.id !== "schedule.launchd" && c.id !== "schedule.tick"), noYes.at(-1)!] });
    expect(initYesLeft(jobless, APP)).toEqual({ must: true, lacks: ["the background job"] });
    const t = await setupPrompt(jobless, APP);
    expect(setupParts(jobless).map((p) => p.state)).toEqual(["do", "do", "do"]);
    expect(t.slice(t.indexOf("## Last"))).toMatch(/\n1\. Run `pmx init` in Terminal and answer its one question\. Setup's one question hasn't had a yes on this Mac, so PMX still lacks the background job; one yes there makes it, and nothing runs by itself until then\. Only the user can give that yes: don't run `pmx init` for them\.\n2\. For each scheduled task you created or updated/);
    // With all four made, nobody is sent back to pmx init.
    expect(initYesLeft(checklist(), APP)).toBeNull();
    expect(await setupPrompt(checklist(), APP)).not.toMatch(/Run `pmx init`/);
  });

  it("before pmx init there is nothing to do in the Claude app, and it says who does what", async () => {
    const cl = checklist({ personal: null, team: null, checks: [ok("os.macos"), ok("node"), ok("claude.installed")], hasRemote: null, memoryFilled: null, proposals: null });
    const text = await setupPrompt(cl, APP);
    expect(text).toMatch(/PMX isn't set up on this Mac yet[\s\S]*Tell the user to run `pmx init` in Terminal themselves[\s\S]*Don't run it for them and never type a token or password/);
    expect(text).not.toContain("## Part");
    expect(formatSetup(cl, APP)).toMatch(/^PMX isn't set up on this Mac yet\. Run `pmx init`/);
  });

  it("the checklist lists the Claude app's steps in the order they're done, and Terminal says the same three steps", async () => {
    const cl = checklist();
    expect(cl.sections.find((s) => s.id === "claude")!.steps.map((s) => s.id)).toEqual(["claude.setup", "claude.allow", "claude.mcp", "claude.tasks", "claude.page", "claude.board"]);
    expect(cl.next).toMatchObject({ id: "claude.tasks", who: "claude", do: expect.stringMatching(/type \/pmx-setup: one chat sets up PMX's tasks, its page and your team's board \(\/pmx-schedule does the tasks alone\)/) });
    expect(formatSetup(cl, { ...APP, serverRunning: false })).toBe([
      "PMX's setup in the Claude app:",
      "  ✘ PMX's scheduled tasks: missing: PMX: collect meetings and update to-dos, PMX: sync Linear through Claude",
      "  ✘ PMX's page in Claude: not published yet. PMX's page shows what's waiting for you, what ran and where your data went.",
      "  ✘ Your team's board: no Claude board yet: type /pmx-board in the Claude app",
      "",
      "In the Claude app's Code tab, type /pmx-setup: one chat does all 3. Quit the app (⌘Q) and open it again first, so it has PMX's commands and starts PMX's server.",
      "Yours afterwards: click Run now on each PMX task once (Code tab → Scheduled) and choose Always allow.",
    ].join("\n"));

    // What init prints last: restart once, one chat, then the first runs.
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
    const team = { ...DEFAULT_TEAM, team: "acme", tracker: LINEAR } as TeamConfig;
    expect(await nextSteps(team, PERSON)).toMatch(/pmx checklist --install-skill/);
    await mkdir(join(appSkillTarget(SETUP_SKILL), ".."), { recursive: true });
    await writeFile(appSkillTarget(SETUP_SKILL), await readFile(appSkillSource(SETUP_SKILL), "utf8"));
    const next = await nextSteps(team, PERSON, { ...APP, serverRunning: false });
    expect(next.split("\n").slice(0, 4)).toEqual([
      "Next step:",
      "  1. Quit the Claude app completely (⌘Q) and open it again, once, so it has PMX's commands and starts PMX's server.",
      "  2. In its Code tab, type /pmx-setup. In that one chat Claude creates PMX's scheduled tasks and publishes PMX's page and your team's board.",
      "  3. When Claude says so, click \"Run now\" on each PMX task once and choose \"Always allow\", so later runs don't stop to ask.",
    ]);
    expect(await nextSteps(team, PERSON, APP)).toContain("  1. Open the Claude desktop app. If /pmx-setup isn't among its commands, quit it (⌘Q) and open it again.");
  });

  it("the skill and the docs say the short path", async () => {
    const root = join(import.meta.dirname, "..");
    const skill = await readFile(join(root, "app-skills", "pmx-setup", "SKILL.md"), "utf8");
    // The skill follows what pmx prints for each part, after the guide and before the checklist's loop.
    const at = (s: string) => { const i = skill.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    expect(at("pmx guide")).toBeLessThan(at("pmx setup --prompt"));
    expect(at("pmx setup --prompt")).toBeLessThan(at("pmx checklist --json"));
    expect(skill).toMatch(/Follow what it prints, not your memory of \/pmx-schedule, \/pmx-flow or \/pmx-board/);
    expect(skill).toMatch(/Say the restart last/);
    // The three separate commands are still there, unchanged in what they read.
    for (const [name, cmd] of [[APP_SKILL, "pmx schedule --json"], [FLOW_SKILL, "pmx flow --publish-json"], [BOARD_SKILL, "pmx board --json"]] as const)
      expect(await readFile(appSkillSource(name), "utf8")).toContain(cmd);

    const install = await readFile(join(root, "INSTALL.md"), "utf8");
    const steps = [...install.matchAll(/^### Step (\d): (.+)$/gm)].map((x) => x[2]);
    expect(steps).toEqual(["one command in Terminal", "answer its few questions", "restart Claude and type /pmx-setup", "Run now and Always allow"]);
    expect(install.indexOf("## If something's missing")).toBeGreaterThan(install.indexOf("### Step 4"));
    expect(install.indexOf("## Appendix: installing by hand, verified")).toBeGreaterThan(install.indexOf("## If something's missing"));
    const guide = await readFile(join(root, "GUIDE.md"), "utf8");
    expect(guide).toContain("pmx setup --prompt");
    expect(guide).toContain("pmx init --ask");
  });
});

describe("npx productmaxxing install goes straight on to pmx init (INSTALL-3)", () => {
  beforeEach(freshHome);

  /** A Mac where npm's own folder is writable and already on PATH, as with Homebrew's Node. */
  async function installer(over: Partial<InstallDeps> = {}) {
    const home = await tmp("install-home-"), global = await tmp("npm-global-");
    const inits: { pmx: string; args: string[] }[] = [];
    const lines: string[] = [];
    const run: Exec = async (cmd, args) => {
      if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: `${global}\n`, stderr: "" };
      if (cmd === "npm" && args[0] === "install") {
        await mkdir(join(global, "lib", "node_modules", "productmaxxing"), { recursive: true });
        await writeFile(join(global, "lib", "node_modules", "productmaxxing", "package.json"), JSON.stringify({ name: "productmaxxing", version: "0.41.0" }));
        await mkdir(join(global, "bin"), { recursive: true });
        await writeFile(join(global, "bin", "pmx"), "#!/usr/bin/env node\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "-ilc") return { code: 0, stdout: `__PMX_FOUND__${(await stat(join(global, "bin", "pmx")).catch(() => null)) ? join(global, "bin", "pmx") : ""}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "not faked" };
    };
    const deps: InstallDeps = {
      exec: run, ask: recordingAsker().ask, yes: false, tty: true, engine: false, home, shell: "/bin/zsh", platform: "darwin", node: { version: "24.1.0", path: "/opt/homebrew/opt/node/bin/node" },
      version: "0.41.0", root: join(home, ".npm", "_npx", "3f2a", "node_modules", "productmaxxing"), personal: null, team: null, writable: async () => true,
      say: (l) => lines.push(l), pmxe: { find: async () => null, next: async () => null }, setupSkill: async () => true,
      init: async (pmx, args) => (inits.push({ pmx, args }), 0), ...over,
    };
    return { deps, inits, lines, global };
  }

  it("in a terminal on a Mac not set up yet, runs the installed pmx's init, never npx's copy, and hands on --repo", async () => {
    const a = await installer({ repo: "git@github.com:acme-co/pmx.git" });
    expect(await runInstall(a.deps)).toBe(0);
    expect(a.inits).toEqual([{ pmx: join(a.global, "bin", "pmx"), args: ["--repo", "git@github.com:acme-co/pmx.git"] }]);
    expect(a.inits[0]!.pmx).not.toContain("_npx");
    expect(a.lines.join("\n")).toContain("Now setting PMX up on this Mac (pmx init): a few questions, then one yes for everything it changes.");
    expect(a.lines.join("\n")).not.toMatch(/Next: .*run pmx init/);
  });

  it("without a terminal, or on a Mac already set up, it doesn't, and says the next step instead", async () => {
    const claude = await installer({ tty: false });
    expect(await runInstall(claude.deps)).toBe(0);
    expect(claude.inits).toEqual([]);
    expect(claude.lines.at(-1)).toBe("Next: run pmx init, or in the Claude app type /pmx-setup and Claude sets PMX up with you.");

    const setUp = await installer({ personal: { handle: "lee", repoPath: "/nowhere" } as PersonalConfig });
    expect(await runInstall(setUp.deps)).toBe(0);
    expect(setUp.inits).toEqual([]);
  });

  it("a setup the person stopped leaves PMX installed, and says how to go on", async () => {
    const a = await installer({ init: async () => 1 });
    expect(await runInstall(a.deps)).toBe(0);
    expect(a.lines.at(-1)).toMatch(/PMX is installed, but setup stopped before it finished\. Run pmx init to go on: it's safe to run again\./);
  });
});

describe("tests can't reach this Mac's launchd, keychain, browser or home", () => {
  it("the real launchctl, security, open and sign-in throw under vitest, and PMX's files resolve to temp folders", async () => {
    const { homedir, tmpdir } = await import("node:os");
    const { macKeychain } = await import("../src/core/keychain.js");
    const { macLaunchd } = await import("../src/core/launchd.js");
    const { loginProfile } = await import("../src/core/claude-bin.js");
    const { pmxHome } = await import("../src/core/paths.js");
    expect(process.env.PMX_TEST_NO_REAL_SYSTEM).toBe("1");
    const refused = /A test reached the real/;
    // Each through the real `exec`, which is what a command gets when a test injects nothing.
    for (const cmd of ["launchctl", "/bin/launchctl", "security", "/usr/bin/security", "open"]) await expect(exec(cmd, ["--version"])).rejects.toThrow(refused);
    const real = macLaunchd();
    await expect(real.isLoaded()).rejects.toThrow(refused);
    await expect(real.install("<plist/>")).rejects.toThrow(refused);
    await expect(real.uninstall()).rejects.toThrow(refused);
    await expect(real.reloadAfter!("<plist/>", process.pid)).rejects.toThrow(refused);
    await expect(macKeychain().get("github-token")).rejects.toThrow(refused);
    await expect(macKeychain().set("github-token", "x")).rejects.toThrow(refused);
    await expect(loginProfile(mac())).rejects.toThrow(refused);
    // With a stand-in injected they work as before: nothing of the guard is in a fake's way.
    const calls: string[][] = [];
    const fake: Exec = async (cmd, args) => (calls.push([cmd, ...args]), { stdout: "", stderr: "", code: 0 });
    await macLaunchd(fake).install("<plist/>");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["launchctl bootout", "launchctl bootstrap"]);
    // The job file a real launchd would write, and PMX's own home, are never the user's.
    for (const f of [paths.launchAgent(), pmxHome(), process.env.PMX_REPO_HOME_FOR_TESTS!, process.env.PMX_CLAUDE_HOME!, process.env.PMX_CLAUDE_DESKTOP_CONFIG!]) {
      expect(f.startsWith(`${homedir()}/Library`) || f.startsWith(`${homedir()}/.`) || f === join(homedir(), "pmx")).toBe(false);
      expect(f).not.toBe(join(homedir(), ".pmx"));
    }
    expect(paths.launchAgent().startsWith(tmpdir())).toBe(true);
    expect(await readFile(paths.launchAgent(), "utf8")).toBe("<plist/>");
  });
});
