// LINEAR-2, LINEAR-2 (Founder 2026-11-27): a personal Linear API key is the default way PMX reaches Linear; the Claude
// app's scheduled task is the fallback. Setup asks for the key once, checks it before saving it, and keeps it in the
// keychain only; with it PMX syncs Linear itself on every background run, asking only for what changed; a Mac on the
// Claude app's sync moves to a key with nothing lost; and a key Linear rejects is said plainly, never worked around.
// Nothing here reaches Linear, the keychain, launchd or the Claude app: Linear is test/fake-linear.ts, the keychain is
// in memory, and every folder is a temp one.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COLLECT_TASK, formatTasks, LINEAR_SYNC_TASK, neededTasks, setTaskHours, taskFile, tasksJson } from "../src/claude/tasks.js";
import { runDoctor } from "../src/commands/doctor.js";
import { commands, tickSteps } from "../src/commands/index.js";
import { runInit, type InitDeps } from "../src/commands/init.js";
import { linearStep, RELAY_NOT_NEEDED } from "../src/commands/linear.js";
import { runTick } from "../src/commands/tick.js";
import { rollup } from "../src/company/rollup.js";
import type { Asker } from "../src/core/ask.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import type { Ctx } from "../src/core/context.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain, type Keychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { services } from "../src/core/services.js";
import { loadState } from "../src/core/state.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { choseClaudeApp, linearAccess } from "../src/linear/access.js";
import { directHealth, readDirect, sayLinearProblem } from "../src/linear/direct.js";
import { adoptKey, checkLinearKey, directFor, drainOutbox, keyHelp, rollupTeams } from "../src/linear/switch.js";
import { NAME_SWAP } from "../src/run/packs.js";
import { evidenceStep, stageShares, storeFor } from "../src/run/share.js";
import { setupPrompt } from "../src/setup/claude-setup.js";
import { gatherChecklist } from "../src/setup/gather.js";
import { LinearError } from "../src/tracker/linear.js";
import { pendingIdentifier, readOutbox, readResolved, readSnapshot, relayDir, relayPrompt, relayTracker } from "../src/tracker/relay.js";
import { FAKE_KEY, fakeLinear } from "./fake-linear.js";
import { freshHome, pmxRepo, quietOut, testCtx, tmp } from "./helpers.js";

const LINEAR = { kind: "linear" as const, teamKey: "ACME", projectId: "proj-1" };
const TEAM = { ...DEFAULT_TEAM, team: "acme", tracker: LINEAR } as TeamConfig;
const NOW = new Date("2026-11-27T10:00:00");
const at = (h: number, m = 0, day = 27) => new Date(2026, 10, day, h, m, 0);

/** Every question asked, with scripted answers by a word in the question; a list of answers is given one per asking. */
function asker(answers: Record<string, string | boolean | string[]> = {}) {
  const asked: { kind: string; q: string }[] = [];
  const find = (q: string) => {
    const hit = Object.entries(answers).find(([k]) => q.toLowerCase().includes(k.toLowerCase()));
    if (!hit) return undefined;
    return Array.isArray(hit[1]) ? hit[1].shift() : hit[1];
  };
  const ask: Asker = {
    async text(q, def = "") { asked.push({ kind: "text", q }); const a = find(q); return typeof a === "string" ? a : def; },
    async secret(q) { asked.push({ kind: "secret", q }); const a = find(q); return typeof a === "string" ? a : ""; },
    async confirm(q, def = true) { asked.push({ kind: "confirm", q }); const a = find(q); return typeof a === "boolean" ? a : def; },
    async choose(q, options, def) { asked.push({ kind: "choose", q }); const a = find(q); return (options.find((o) => o === a) ?? def) as any; },
  };
  return { ask, asked };
}

/** This Mac's commands for `pmx init`: Claude Code is there and signed in, git is real, everything else is a stand-in. */
const mac: Exec = async (cmd, args, opts) => {
  if (cmd === "claude" || cmd.endsWith("/claude")) {
    if (args[0] === "--version") return cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : { stdout: "", stderr: "ENOENT", code: 127 };
    if (args[0] === "auth") return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }), stderr: "", code: 0 };
    return { stdout: "", stderr: "not faked", code: 1 };
  }
  if (cmd === "git" && args.join(" ") === "config --get user.email") return { stdout: "lee@acme.example\n", stderr: "", code: 0 };
  if (cmd === "git") return exec(cmd, args, opts);
  return { stdout: "", stderr: `${cmd}: not faked`, code: 1 };
};

async function freshMac() {
  const pmx = await freshHome();
  const home = await tmp("user-home-");
  process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  await mkdir(join(pmx, "claude-desktop"), { recursive: true });
  process.env.USER = "lee";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) process.env[k] = "Test";
  for (const k of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) process.env[k] = "test@example.com";
  return { pmx, home, cwd: await tmp("somewhere-"), launchd: fakeLaunchd() };
}

async function teamRepo(team: Partial<TeamConfig> = {}) {
  const { origin } = await pmxRepo({ team: "acme", tracker: LINEAR, internalDomains: ["acme.example"], ...team }, { remote: true });
  return `file://${origin}`;
}

const init = (m: { home: string; cwd: string; launchd: ReturnType<typeof fakeLaunchd> }, over: Partial<InitDeps>): InitDeps => ({
  ask: asker().ask, keychain: memoryKeychain(), launchd: m.launchd, exec: mac, out: quietOut(), now: () => NOW,
  cliPath: "/x/lib/node_modules/productmaxxing/dist/src/cli.js", login: async () => 0, home: m.home, cwd: m.cwd, ...over,
});

/** Every file under a folder, with its text, for the "the key is nowhere on disk" check. */
async function everyFile(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await everyFile(p)));
    else if (e.isFile()) out.push({ file: p, text: await readFile(p, "latin1") });
  }
  return out;
}

async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const orig = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try { await run(); } finally { [console.log, console.warn, console.error] = orig; }
  return logs.flatMap((l) => l.split("\n"));
}

const linearCmd = commands.find((c) => c.name === "linear")!;
const pmxLinear = (ctx: Ctx, positionals: string[], o: { values?: Record<string, unknown>; ask?: Asker } = {}) =>
  printed(() => linearCmd.run({ values: o.values ?? {}, positionals, ask: o.ask ?? asker().ask, cliPath: "", ctx: async () => ctx }));

/** A Mac set up on team ACME, reaching Linear as its keychain says, at a time the test moves. */
async function onTeam(o: { keychain?: Keychain; fetch?: typeof fetch; team?: Partial<TeamConfig>; handle?: string } = {}) {
  const { repo } = await pmxRepo({ team: "acme", tracker: LINEAR, ...o.team });
  const clock = { now: NOW };
  const ctx = await testCtx({ repo, team: { team: "acme", tracker: LINEAR, ...o.team } as Partial<TeamConfig>, keychain: o.keychain ?? memoryKeychain(), fetch: o.fetch, personal: { handle: o.handle ?? "lee" } });
  ctx.now = () => clock.now;
  return { ctx, clock, repo };
}

const issueNode = (identifier: string, labels: [string, string][], over: Record<string, unknown> = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: "", url: `https://linear.app/x/${identifier}`, priority: 0, createdAt: "2026-11-20T09:00:00.000Z",
  state: { name: "Backlog", type: "backlog" }, assignee: null, labels: { nodes: labels.map(([g, n]) => ({ name: n, parent: { name: g } })) }, comments: { nodes: [] }, ...over,
});

async function relaySnapshot(issues: unknown[], syncedAt = "2026-11-27T01:00:00.000Z") {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt, projectId: "proj-1", labels: [], issues }));
}

async function claudeTask(t: { id: string; prompt: string }) {
  await mkdir(join(taskFile(t.id), ".."), { recursive: true });
  await writeFile(taskFile(t.id), `---\nname: x\n---\n\n${t.prompt}`);
}

describe("setup asks a PM on a Linear team for their Linear API key, once (LINEAR-2)", () => {
  let m: Awaited<ReturnType<typeof freshMac>>;
  beforeEach(async () => { m = await freshMac(); });

  it("says where to create it and the least it needs, checks it with one read, and keeps it in the keychain", async () => {
    const url = await teamRepo();
    const linear = fakeLinear({ now: () => NOW });
    const { ask, asked } = asker({ "Linear API key": FAKE_KEY });
    const out = quietOut(), keychain = memoryKeychain();
    await runInit(init(m, { ask, out, keychain, repo: url, fetch: linear.f }));

    // One yes and the key: with the repo's place, three questions at most for a joining PM.
    expect(asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(asked[1]!.q).toBe("Linear API key (Return to use the Claude app instead)");
    const said = out.lines.join("\n");
    // Where to create it, what to choose (never Admin), and only the team that holds the PMX project.
    expect(said).toContain("Create it in Linear: Settings → Account → Security & access → Personal API keys → New API key.");
    expect(said).toMatch(/Permissions: Read and Write\. Not Admin, and not Full access: PMX changes no workspace or team setting\. "Create issues" and "Create comments" alone aren't enough/);
    expect(said).toContain("Team access: only ACME, the team that holds your PMX project.");
    expect(said).toMatch(/Press Return: PMX then goes through your Claude app's Linear connector, which syncs once an hour\./);
    // The check was one read: whose key it is, the team and the project. Then PMX's own labels, missing on a new team.
    expect(linear.calls[0]).toMatchObject({ op: "viewer", vars: { keys: ["ACME"], id: "proj-1" } });
    expect(linear.calls[0]!.query).toMatch(/^query/);
    expect(said).toMatch(/Linear key for Sam Lee: can read and write Acme Product's PMX project \(PMX added the \d+ labels of its own that were missing there\)\./);
    expect(await keychain.get("linear-token")).toBe(FAKE_KEY);
    expect(said).toContain("Saved the key in this Mac's keychain. PMX now reads and writes Linear itself, with every background run");
    expect(said).toContain("Linear: PMX reaches it with your API key, with every background run.");
    expect(await linearAccess(TEAM, keychain)).toBe("key");
    // The page has PMX's own copy from the first minute.
    expect(await readSnapshot()).toMatchObject({ projectId: "proj-1", syncedAt: NOW.toISOString(), issues: [] });

    // A rerun asks nothing: the key is there.
    const again = asker();
    await runInit(init(m, { ask: again.ask, keychain, fetch: linear.f }));
    expect(again.asked).toEqual([]);
  });

  it("Return means the Claude app instead, is remembered, and a rerun doesn't ask again", async () => {
    const url = await teamRepo();
    const first = asker(), out = quietOut(), keychain = memoryKeychain();
    await runInit(init(m, { ask: first.ask, out, keychain, repo: url }));
    expect(first.asked.map((a) => a.kind)).toEqual(["choose", "secret"]);
    expect(out.lines.join("\n")).toContain("No key: PMX reaches Linear through your Claude app's Linear connector, once an hour. /pmx-setup sets its sync task up. To use a key later: pmx linear key.");
    expect(await keychain.get("linear-token")).toBeNull();
    expect(await choseClaudeApp()).toBe(true);
    // Remembered beside the settings, never in them.
    expect(await readFile(paths.config(), "utf8")).not.toMatch(/linear|claude-app/i);
    expect((await loadState()).linearChoice).toEqual({ via: "claude-app", at: NOW.toISOString() });

    const again = asker();
    await runInit(init(m, { ask: again.ask, keychain }));
    expect(again.asked).toEqual([]);
    // The Linear sync task is what this Mac needs then, as before.
    expect((await neededTasks(TEAM, keychain)).map((t) => t.id)).toEqual([COLLECT_TASK.id, LINEAR_SYNC_TASK.id]);
    // `pmx init --ask` goes through every answer, this one too.
    const all = asker({ "PMX repo checkout": join(m.home, "pmx") });
    await runInit(init(m, { ask: all.ask, keychain, askAll: true }));
    expect(all.asked.filter((a) => a.kind === "secret").map((a) => a.q)).toEqual(["Linear API key (Return to use the Claude app instead)"]);
  });

  it("--yes and a run nobody can answer neither ask for a key nor remember a choice", async () => {
    const url = await teamRepo();
    const yes = asker(), keychain = memoryKeychain(), out = quietOut();
    await runInit(init(m, { ask: yes.ask, out, keychain, repo: url, yes: true }));
    expect(yes.asked.map((a) => a.kind)).toEqual(["choose"]);
    expect(await choseClaudeApp()).toBe(false);
    expect(out.lines.join("\n")).toContain("PMX's usual way is your own Linear API key, which syncs with every background run: run pmx linear key in Terminal.");
    const nobody = asker();
    await runInit(init(m, { ask: nobody.ask, keychain, unattended: true }));
    expect(nobody.asked).toEqual([]);
    expect(await choseClaudeApp()).toBe(false);
    // The next run with a person asks.
    const person = asker();
    await runInit(init(m, { ask: person.ask, keychain }));
    expect(person.asked.map((a) => a.q)).toEqual(["Linear API key (Return to use the Claude app instead)"]);
  });

  it("a team without Linear, a Mac signed in to Linear and a team on the hosted app are never asked", async () => {
    const none = asker();
    await runInit(init(m, { ask: none.ask, repo: await teamRepo({ tracker: { kind: "none" } }) }));
    expect(none.asked.map((a) => a.kind)).toEqual(["choose"]);
    const other = await freshMac();
    const signedIn = asker();
    await runInit(init(other, { ask: signedIn.ask, repo: await teamRepo(), keychain: memoryKeychain({ "linear-oauth": JSON.stringify({ access: "a", refresh: "r", expiresAt: "2099-01-01T00:00:00Z", clientId: "c", user: null }) }) }));
    expect(signedIn.asked.map((a) => a.kind)).toEqual(["choose"]);
  });

  it("refuses a key that isn't one, that Linear rejects, that can't see the team or the project, or that can't write, and saves nothing", async () => {
    const check = (linear: ReturnType<typeof fakeLinear>, key = FAKE_KEY) => checkLinearKey({ team: TEAM, fetch: linear.f, now: () => NOW }, key);
    // Not a key at all (a command pasted into the prompt): Linear isn't even asked.
    const untouched = fakeLinear();
    expect(await check(untouched, "pmx linear key")).toEqual({ ok: false, lines: ["That isn't a Linear API key: one starts with lin_api_ and has no spaces. Nothing was saved."] });
    expect(untouched.calls).toEqual([]);
    // Revoked or mistyped.
    const rejected = fakeLinear(); rejected.mode.now = "rejected";
    expect((await check(rejected)).lines).toEqual(["Linear didn't accept that key: it's mistyped, cut short, or already revoked. Nothing was saved."]);
    // Restricted to another team.
    const otherTeam = fakeLinear({ teams: [{ key: "OPS", name: "Operations" }], projects: [] });
    expect((await check(otherTeam)).lines[0]).toMatch(/^Linear key for Sam Lee: it can't see team ACME, which holds your PMX project\. The key's team access must include ACME, with Read and Write\. Create a key that has it \(Settings → Account → Security & access → Personal API keys → New API key\) and paste that\. Nothing was saved\.$/);
    // Sees the team, not the project.
    const noProject = fakeLinear({ projects: [] });
    expect((await check(noProject)).lines[0]).toMatch(/^Linear key for Sam Lee: it sees team Acme Product but not its PMX project \(proj-1\)\./);
    // Read only: the one change PMX makes at the check (its own missing labels) is refused, and so is the key.
    const readOnly = fakeLinear(); readOnly.mode.now = "read-only";
    const r = await check(readOnly);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^Linear key for Sam Lee: can read Acme Product's PMX project but not change it \(Linear said: Invalid scope: `write` required\)\. PMX needs Read and Write on ACME\./);
    // Offline.
    const down = fakeLinear(); down.mode.now = "down";
    expect((await check(down)).lines[0]).toMatch(/^PMX couldn't reach Linear to check the key \(fetch failed\)\. Nothing was saved/);
    // A team whose labels are all there: the read is all PMX can show, and it says so instead of claiming more.
    const full = fakeLinear();
    expect((await check(full)).ok).toBe(true);
    expect((await check(full)).lines).toEqual(["Linear key for Sam Lee: can read Acme Product's PMX project. PMX's labels are all there, so it had nothing to change yet: its first change shows whether the key may write (it needs Read and Write)."]);

    // In setup: each refusal asks again, Return then means the Claude app, and no key was ever saved.
    const url = await teamRepo();
    const linear = fakeLinear({ projects: [] });
    const { ask, asked } = asker({ "Linear API key": [FAKE_KEY, ""] });
    const out = quietOut(), keychain = memoryKeychain();
    await runInit(init(m, { ask, out, keychain, repo: url, fetch: linear.f }));
    expect(asked.map((a) => a.q)).toEqual([expect.stringMatching(/^Go ahead/), "Linear API key (Return to use the Claude app instead)", "Linear API key (paste another, or Return to use the Claude app instead)"]);
    expect(out.lines.join("\n")).toMatch(/WARN Linear key for Sam Lee: it sees team Acme Product but not its PMX project/);
    expect(await keychain.list()).toEqual([]);
    expect(await choseClaudeApp()).toBe(true);
  });

  it("the key is in the keychain and nowhere else: no file, no output, no error, whatever happens with it", async () => {
    const url = await teamRepo();
    const linear = fakeLinear({ now: () => NOW });
    const out = quietOut(), keychain = memoryKeychain();
    const p = await runInit(init(m, { ask: asker({ "Linear API key": FAKE_KEY }).ask, out, keychain, repo: url, fetch: linear.f }));
    // A background run, a task created with it, then Linear rejecting it, a refused change and the rate limit.
    const ctx = await testCtx({ repo: p.repoPath, team: { team: "acme", tracker: LINEAR }, keychain, fetch: linear.f, personal: { handle: "lee" }, now: NOW });
    const said: string[] = [];
    said.push(...(await runTick(ctx, [["linear", linearStep]])));
    await (await services(ctx)).tracker.createInbox({ title: "Spec the export", description: "d", category: "spec", size: "S", sources: [] });
    for (const mode of ["rejected", "read-only", "limited", "down"] as const) {
      linear.mode.now = mode;
      await readDirect().then(async (r) => { r.problem = null; const { saveDirect } = await import("../src/linear/direct.js"); await saveDirect(r); });
      said.push(...(await runTick(ctx, [["linear", linearStep], ["write", async (c) => { await (await services(c)).tracker.createInbox({ title: "Another", description: "d", category: "spec", size: "S", sources: [] }); return null; }]])));
      said.push(...(await checkLinearKey({ team: TEAM, fetch: linear.f, now: () => NOW }, FAKE_KEY)).lines);
    }
    said.push(...(await printed(async () => { await linearCmd.run({ values: {}, positionals: ["status"], ask: asker().ask, cliPath: "", ctx: async () => ctx }); })));
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: () => NOW });
    const cl = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx });
    said.push(JSON.stringify(checks), JSON.stringify(cl), ...out.lines, ...ctx.out.lines);

    // Linear got it, as its Authorization header and nothing else; nothing PMX said or wrote has it.
    expect([...linear.auths]).toEqual([FAKE_KEY]);
    expect(linear.calls.some((c) => JSON.stringify(c.vars).includes(FAKE_KEY) || c.query.includes(FAKE_KEY))).toBe(false);
    expect(said.join("\n")).not.toContain(FAKE_KEY);
    expect(said.join("\n")).not.toContain(FAKE_KEY.slice(8, 20));
    const files = [...(await everyFile(m.pmx)), ...(await everyFile(m.home)), ...(await everyFile(process.env.PMX_CLAUDE_HOME!)), ...(await everyFile(m.cwd))];
    // The settings, the state, PMX's Linear records, the checklist and the team repo are all among them.
    for (const name of ["config.json", "direct.json", "snapshot.json", "checklist.json", "pmx.config.json"]) expect(files.some((f) => f.file.endsWith(name)), name).toBe(true);
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => f.text.includes(FAKE_KEY) || f.text.includes(FAKE_KEY.slice(8, 20))).map((f) => f.file)).toEqual([]);
  });
});

describe("with a key, the Claude app's Linear task isn't needed (LINEAR-2, CLAUDE-1)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("claude-home-"); });

  it("/pmx-schedule, doctor and the checklist set up and expect only meeting collection", async () => {
    const keychain = memoryKeychain({ "linear-token": FAKE_KEY });
    const { ctx } = await onTeam({ keychain });
    expect((await neededTasks(TEAM, keychain)).map((t) => t.id)).toEqual([COLLECT_TASK.id]);
    const json = await tasksJson(TEAM, keychain);
    expect(json.missing.map((t) => t.taskId)).toEqual([COLLECT_TASK.id]);
    expect(json.notNeeded).toEqual([]);
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: () => NOW });
    expect(checks.filter((c) => c.id.startsWith("claude.task.")).map((c) => c.id)).toEqual(["claude.task.pmx-collect-meetings"]);
    expect(checks.find((c) => c.id === "linear.relay")).toBeUndefined();
    const cl = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx });
    const step = (id: string) => cl.sections.flatMap((s) => s.steps).find((s) => s.id === id);
    expect(step("claude.tasks")).toMatchObject({ status: "todo", detail: "missing: PMX: collect meetings and update to-dos" });
    expect(step("linear.key")).toBeUndefined();
  });

  it("a Linear sync task left from before is said once as safe to remove, never as a problem, and does nothing if it runs", async () => {
    const linear = fakeLinear({ now: () => NOW });
    const keychain = memoryKeychain({ "linear-token": FAKE_KEY });
    const { ctx } = await onTeam({ keychain, fetch: linear.f });
    await claudeTask(COLLECT_TASK);
    await claudeTask(LINEAR_SYNC_TASK);

    // /pmx-schedule is told it's not needed, and neither creates nor updates it.
    const json = await tasksJson(TEAM, keychain);
    expect([json.missing, json.outdated, json.present]).toEqual([[], [], [COLLECT_TASK.id]]);
    expect(json.notNeeded).toEqual([{ taskId: LINEAR_SYNC_TASK.id, title: LINEAR_SYNC_TASK.title, why: expect.stringMatching(/^"PMX: sync Linear through Claude" is still in your Claude app, and PMX no longer needs it: this Mac reaches Linear itself\. If it still runs it does nothing\. Safe to delete/) }]);
    const skill = await readFile(join(import.meta.dirname, "..", "app-skills", "pmx-schedule", "SKILL.md"), "utf8");
    expect(skill).toMatch(/If `notNeeded` lists a task, PMX no longer needs it on this Mac[^\n]*leave it alone, don't count it as a problem, and in step 7 tell the user once what its `why` says/);
    const text = await formatTasks(TEAM, keychain);
    expect(text).toContain("· \"PMX: sync Linear through Claude\" is still in your Claude app, and PMX no longer needs it");
    expect(text).toContain("Every Claude task this machine needs is set up.");
    expect(text).not.toMatch(/[✘!] PMX: sync Linear/);

    // The background run's log says it once.
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([expect.stringMatching(/^linear: The "PMX: sync Linear through Claude" task in your Claude app isn't needed any more: with your key PMX syncs Linear itself\. If it still runs it does nothing\. Delete it when you like: Claude app, Code tab → Scheduled → the task → Delete\.$/)]);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([]);

    // Doctor and the checklist: a passing line and a finished step. Nothing to fix, nothing warned.
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: () => NOW });
    expect(checks.find((c) => c.id === "linear.task-left")).toMatchObject({ ok: true });
    expect(checks.filter((c) => /pmx-sync-linear/.test(c.id))).toEqual([]);
    const cl = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx });
    const steps = cl.sections.flatMap((s) => s.steps);
    expect(steps.find((s) => s.id === "claude.tasks")).toMatchObject({ status: "done", detail: "1 task set up and running" });
    expect(steps.find((s) => s.id === "linear.hours")).toMatchObject({ status: "done", detail: expect.stringMatching(/"PMX: sync Linear through Claude" is still in your Claude app, and PMX no longer needs it/) });
    expect(steps.filter((s) => s.status !== "done" && /sync Linear/.test(s.detail))).toEqual([]);

    // If the app still runs it: its first step says stop, its last step says the same, and neither touches a thing,
    // outside working hours too. No export is asked for, so nothing overwrites PMX's own copy.
    await linearStep(ctx);
    const before = { snapshot: await readFile(join(relayDir(), "snapshot.json"), "utf8"), dir: (await readdir(relayDir())).sort(), calls: linear.calls.length };
    ctx.personal.taskHours = "weekdays";
    const sunday = { ...ctx, now: () => new Date(2026, 10, 29, 3, 0, 0) } as Ctx;
    for (const run of [ctx, sunday]) {
      expect(await pmxLinear(run, ["relay"], { values: { prompt: true } })).toEqual([RELAY_NOT_NEEDED]);
      expect(await pmxLinear(run, ["relay"], { values: { check: true } })).toEqual([RELAY_NOT_NEEDED]);
    }
    expect(RELAY_NOT_NEEDED).toMatch(/this task has nothing to do\. Stop here: report "PMX syncs Linear itself now; this task is no longer needed and is safe to delete\." and do nothing else\. Don't use the Linear connector, and don't write any file\./);
    expect({ snapshot: await readFile(join(relayDir(), "snapshot.json"), "utf8"), dir: (await readdir(relayDir())).sort(), calls: linear.calls.length }).toEqual(before);
    // The app's Runs list shows it finished, so nothing reads as a stuck run.
    expect((await loadState()).taskRuns[LINEAR_SYNC_TASK.id]?.finishedAt).toBeTruthy();
  });
});

describe("switching a working Mac from the Claude app's sync to a key loses nothing (LINEAR-2)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("claude-home-"); });

  /** A Mac on the Claude app's sync with a copy from last night and changes queued since. */
  async function relayMac() {
    const linear = fakeLinear({ now: () => NOW });
    const old = linear.seed("Spec the bulk editor", [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "M"]], { stateId: "S-todo" });
    const keychain = memoryKeychain();
    const { ctx, clock } = await onTeam({ keychain, fetch: linear.f });
    await relaySnapshot([issueNode(old.identifier, [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "M"]], { id: old.id, title: old.title, state: { name: "Todo", type: "unstarted" } })]);
    const relay = relayTracker(ctx.team, () => {}, ctx.now);
    return { linear, old, keychain, ctx, clock, relay };
  }
  const key = (ctx: Ctx, value = FAKE_KEY, values: Record<string, unknown> = {}) => pmxLinear(ctx, ["key"], { ask: asker({ "Linear API key": value }).ask, values });

  it("everything queued is applied in Linear at once, in order, and PENDING identifiers resolve as the sync would have resolved them", async () => {
    const { linear, old, keychain, ctx, relay } = await relayMac();
    // Approved with Start now and a theme, a comment that names it, a meeting marker that lists it, and changes to an older task.
    const made = await relay.createInbox({ title: "Spec export naming rules", description: "From a customer call.\npmx:source T1", category: "spec", size: "S", sources: ["T1"], ready: true, theme: "Exports" });
    expect(made.identifier).toMatch(/^PENDING-[0-9A-F]{6}$/);
    await relay.comment(old.identifier, `pmx:note see ${made.identifier}`);
    await relay.setStatus(old.identifier, "claimed");
    await relay.setAgent(old.identifier, "lee@m1");
    const marker = await relay.lodgeMeeting({ keys: ["m1234567890"], at: "2026-11-27", agent: "lee@m1" });
    await relay.finishMeeting(marker.id, { status: "done", tasks: [made.identifier], note: "pmx: processed" });
    await relay.setPriority(made.id, 2);
    const queued = (await readOutbox()).ops;
    expect(queued.map((o) => o.kind)).toEqual(["create-task", "set-label", "comment", "set-status", "set-agent", "lodge-meeting", "finish-meeting", "set-priority"]);
    // Its quotes wait to be shared under the placeholder.
    const quotes = [{ id: "T1", kind: "meeting" as const, at: "2026-11-26", passages: ["Admins rename every export by hand before the weekly upload."] }];
    await stageShares(ctx, [{ identifier: made.identifier, title: made.title, description: made.description, sources: ["T1"], quotes, quotesSwap: NAME_SWAP }]);

    const said = await key(ctx);
    expect(said.join("\n")).toMatch(/Linear key for Sam Lee: can read and write Acme Product's PMX project/);
    expect(said).toContain("Sent 8 change(s) that were waiting for the Claude app's sync straight to Linear.");
    expect((await readOutbox()).ops).toEqual([]);
    expect(await keychain.get("linear-token")).toBe(FAKE_KEY);

    // In Linear: the new task as approved, with its theme and priority; the comment and the marker name it by its real identifier.
    const task = [...linear.issues.values()].find((i) => i.title === "Spec export naming rules")!;
    expect(task).toMatchObject({ description: "From a customer call.\npmx:source T1", stateId: "S-todo", priority: 2 });
    expect(["pmx-status", "pmx-category", "pmx-size", "pmx-theme", "pmx-state"].map((g) => linear.labelOf(task.id, g))).toEqual(["ready", "spec", "S", "Exports", "unstarted"]);
    expect(linear.find(old.id)).toMatchObject({ comments: [`pmx:note see ${task.identifier}`], assigneeId: "user-me", stateId: "S-prog" });
    expect([linear.labelOf(old.id, "pmx-status"), linear.labelOf(old.id, "pmx-agent")]).toEqual(["claimed", "lee@m1"]);
    const lodged = [...linear.issues.values()].find((i) => i.title === marker.title)!;
    expect(lodged.description).toContain(`pmx:task ${task.identifier}`);
    expect(lodged.description).not.toContain("PENDING-");
    expect([linear.labelOf(lodged.id, "pmx-kind"), linear.labelOf(lodged.id, "pmx-status"), lodged.stateId]).toEqual(["meeting", "done", "S-done"]);
    // Nothing was created twice.
    expect(linear.ops().filter((o) => o === "issueCreate")).toHaveLength(2);

    // The placeholder leads to the real task, as after a sync.
    expect((await readResolved())[made.identifier]).toEqual({ identifier: task.identifier, at: NOW.toISOString() });
    expect((await readResolved())[marker.identifier]?.identifier).toBe(lodged.identifier);
    // So its staged quotes reached the team under the real identifier, right then, and the background run's pass,
    // which lets go of a share whose task left the queue without one, has nothing to let go of.
    expect(await storeFor(ctx).list()).toEqual([task.identifier]);
    expect(await evidenceStep(ctx, () => services(ctx))).toBeNull();

    // The page's copy is PMX's own read from this minute, with the new task in it: no gap, and no wait for a sync.
    const snap = (await readSnapshot())!;
    expect(snap.syncedAt).toBe(NOW.toISOString());
    expect(snap.issues.map((n: any) => n.identifier).sort()).toEqual([old.identifier, task.identifier, lodged.identifier].sort());
    expect(snap.issues.find((n: any) => n.id === task.id).labels.nodes.map((l: any) => l.name)).toContain("Exports");
    const page = await loadPipeline(ctx, { level: "local", hours: 168, keychain });
    expect(page.freshness).toMatchObject({ linearVia: "direct", linearSyncedAt: null, linearReadAt: NOW.toISOString() });
  });

  it("a to-do sent to the team before the switch still finds its task afterwards", async () => {
    const { linear, keychain, ctx, relay } = await relayMac();
    const { moveWork } = await import("../src/todo/move.js");
    const { addTodo, loadTodos } = await import("../src/todo/todo.js");
    const todo = await addTodo({ text: "Write up the export naming need" }, NOW);
    const made = await moveWork(ctx, async () => ({ tracker: relay }) as any, todo.id, "product", { kind: "spec" });
    expect(made.identifier).toMatch(/^PENDING-/);
    await key(ctx);
    const task = [...linear.issues.values()].find((i) => /export naming need/.test(i.title))!;
    expect(task).toBeTruthy();
    // Taking it back by the identifier it was given then: PMX finds the real issue and cancels it there.
    const back = await moveWork(ctx, () => services(ctx), made.identifier!, "private");
    expect(back.message).toContain(task.identifier);
    expect(linear.find(task.id).stateId).toBe("S-cxl");
    expect((await loadTodos()).items.map((t) => t.text)).toEqual(["Write up the export naming need"]);
    expect(await keychain.get("linear-token")).toBe(FAKE_KEY);
  });

  it("a change Linear refuses stays queued, is tried again by the background run, and is dropped after three refusals with what hangs on it", async () => {
    const { linear, old, ctx, relay, clock } = await relayMac();
    linear.mode.refuseTitle = /forbidden word/;
    const bad = await relay.createInbox({ title: "A forbidden word here", description: "d", category: "spec", size: "S", sources: [] });
    await relay.setPriority(bad.id, 1);
    await relay.setStatus(old.identifier, "claimed");
    const said = await key(ctx);
    // The good change went; the refused one and the change that needs its issue wait.
    expect(said.join("\n")).toMatch(/Sent 1 change\(s\) that were waiting for the Claude app's sync straight to Linear; 2 still wait\./);
    expect(said.join("\n")).toMatch(/✘ Linear refused create PENDING-[0-9A-F]{6}: Linear: Title is not allowed\. PMX tries again at the next background run, up to 3 times\. To drop it now: pmx linear outbox drop [0-9a-f]{8}/);
    expect(linear.labelOf(old.id, "pmx-status")).toBe("claimed");
    expect((await readOutbox()).ops.map((o) => [o.kind, o.failures ?? 0])).toEqual([["create-task", 1], ["set-priority", 0]]);
    expect((await pmxLinear(ctx, ["outbox"]))[0]).toMatch(/^2 change\(s\) queued before this Mac had its Linear API key wait for the next background run, which sends them straight to Linear; Linear refused 1 of them/);

    clock.now = at(10, 30);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([]);
    expect((await readOutbox()).ops.map((o) => o.failures ?? 0)).toEqual([2, 0]);
    clock.now = at(11, 0);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([expect.stringMatching(/^linear: ✘ gave up on create PENDING-[0-9A-F]{6} after Linear refused it 3 times: Linear: Title is not allowed\. It's dropped; nothing more of it goes to Linear\.$/)]);
    expect((await readOutbox()).ops).toEqual([]);
    expect([...linear.issues.values()].map((i) => i.title)).toEqual([old.title]);
  });

  it("an outage or a rate limit in the middle keeps everything not yet sent, and counts as no refusal", async () => {
    const { linear, old, ctx, relay, clock } = await relayMac();
    await relay.setStatus(old.identifier, "claimed");
    await relay.createInbox({ title: "Spec export naming rules", description: "d", category: "spec", size: "S", sources: [] });
    // The key is checked and saved, then Linear goes away as PMX starts its first read of the project.
    const good = linear.f;
    ctx.fetch = (async (u: any, i: any) => { if (/project\(id: \$id\) \{ issues/.test(JSON.parse(i.body).query)) linear.mode.now = "down"; return good(u, i); }) as typeof fetch;
    const said = await key(ctx);
    expect(said.join("\n")).toMatch(/PMX couldn't finish its first read of Linear with the key \(fetch failed\)\. The key is saved; the next background run reads Linear and sends anything still waiting\./);
    expect((await readOutbox()).ops.map((o) => [o.kind, o.failures ?? 0])).toEqual([["set-status", 0], ["create-task", 0]]);
    // Linear is back at the next background run: both go, once each.
    linear.mode.now = "ok";
    ctx.fetch = good;
    clock.now = at(10, 30);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual(["linear: Sent 2 change(s) that were waiting for the Claude app's sync straight to Linear."]);
    expect((await readOutbox()).ops).toEqual([]);
    expect(linear.ops().filter((o) => o === "issueCreate")).toHaveLength(1);
  });

  it("a Claude sync under way when the key is pasted keeps its changes: PMX takes in what it applied and never applies them twice", async () => {
    const { linear, ctx, relay, clock } = await relayMac();
    await relay.createInbox({ title: "Spec export naming rules", description: "d", category: "spec", size: "S", sources: [] });
    const [op] = (await readOutbox()).ops;
    // The app's task has read its instructions and is applying the outbox when the PM pastes the key.
    await relayPrompt(ctx.team, NOW);
    clock.now = at(10, 2);
    const said = await key(ctx);
    expect(said).toContain("A Linear sync is running in your Claude app right now, so PMX leaves the changes it's applying to it, and sends whatever it doesn't with the next background run.");
    expect((await readOutbox()).ops).toHaveLength(1);
    expect(linear.ops()).not.toContain("issueCreate");
    // The task creates the issue through its connector, reports it, and wrote an export, as its instructions said.
    const there = linear.seed("Spec export naming rules", [["pmx-status", "inbox"]]);
    await writeFile(join(relayDir(), "results.json"), JSON.stringify([{ id: op!.id, ok: true, identifier: there.identifier, issueId: there.id }]));
    const mine = await readFile(join(relayDir(), "snapshot.json"), "utf8");
    clock.now = at(10, 4);
    const check = await pmxLinear(ctx, ["relay"], { values: { check: true } });
    expect(check).toEqual(["Applied 1 change(s) in Linear; 0 still waiting.", expect.stringMatching(/^PMX: this Mac reaches Linear with its own API key now/)]);
    expect((await readOutbox()).ops).toEqual([]);
    expect((await readResolved())[pendingIdentifier(op!.id)]?.identifier).toBe(there.identifier);
    // PMX's own copy stays its own: the app's export is not taken in over it.
    expect(await readFile(join(relayDir(), "snapshot.json"), "utf8")).toBe(mine);
    // The next background run has nothing left to send, and its read brings the new task in.
    clock.now = at(10, 30);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([]);
    expect(linear.ops()).not.toContain("issueCreate");
    expect((await readSnapshot())!.issues.map((n: any) => n.identifier)).toContain(there.identifier);
  });

  it("pmx linear key replaces a key, keeps one on Return, and --remove goes back to the Claude app's sync", async () => {
    const { keychain, ctx, linear } = await relayMac();
    // Return with no key stored: the Claude app, remembered.
    expect((await key(ctx, "")).at(-1)).toBe("No key saved. PMX reaches Linear through your Claude app's Linear connector, once an hour, and won't ask again. To use a key later: pmx linear key.");
    expect(await choseClaudeApp()).toBe(true);
    await key(ctx);
    expect(await choseClaudeApp()).toBe(false);
    expect((await services(ctx)).tracker.kind).toBe("linear");
    // Return with a key stored keeps it; a refused one leaves the stored key in place.
    expect((await key(ctx, "")).at(-1)).toBe("Nothing changed: the key in the keychain stays.");
    linear.mode.now = "rejected";
    expect((await key(ctx, "lin_api_another")).at(-1)).toBe("Linear didn't accept that key: it's mistyped, cut short, or already revoked. Nothing was saved.");
    expect(await keychain.get("linear-token")).toBe(FAKE_KEY);
    linear.mode.now = "ok";

    const removed = await key(ctx, "", { remove: true });
    expect(removed[0]).toBe("Removed the Linear API key from this Mac's keychain. PMX now reaches Linear through your Claude app's Linear connector, once an hour.");
    expect(removed[1]).toMatch(/^Type \/pmx-schedule in the Claude app/);
    expect(await keychain.get("linear-token")).toBeNull();
    expect(await choseClaudeApp()).toBe(true);
    expect((await services(ctx)).tracker.kind).toBe("claude-relay");
    expect((await neededTasks(ctx.team, keychain)).map((t) => t.id)).toEqual([COLLECT_TASK.id, LINEAR_SYNC_TASK.id]);
    // Its first sync through the app exports the whole project again.
    expect(await relayPrompt(ctx.team, ctx.now())).toContain("## 2. Export the project for PMX");
  });
});

describe("the direct sync is light and says when something is wrong (LINEAR-2)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("claude-home-"); });

  async function keyMac(o: { team?: Partial<TeamConfig>; linear?: Parameters<typeof fakeLinear>[0]; handle?: string } = {}) {
    const clock = { now: NOW };
    const linear = fakeLinear({ now: () => clock.now, ...o.linear });
    const keychain = memoryKeychain({ "linear-token": FAKE_KEY });
    const m = await onTeam({ keychain, fetch: linear.f, team: o.team, handle: o.handle });
    m.ctx.now = () => clock.now;
    return { linear, keychain, ctx: m.ctx, clock };
  }
  const reads = (linear: ReturnType<typeof fakeLinear>) => linear.calls.filter((c) => c.op === "project").map((c) => c.vars.since ?? "whole");

  it("each background run asks only for what changed since the last; the whole project once a day", async () => {
    const { linear, ctx, clock } = await keyMac();
    const a = linear.seed("Spec the bulk editor", [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "M"]], { stateId: "S-todo" });
    const b = linear.seed("Brief the pricing change", [["pmx-status", "inbox"], ["pmx-category", "spec"], ["pmx-size", "S"]]);
    // The first run reads the whole project, once.
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([]);
    expect(reads(linear)).toEqual(["whole"]);
    expect(linear.calls).toHaveLength(1);

    // Half an hour on, nothing changed: one short question, and no issue comes back.
    clock.now = at(10, 30);
    await runTick(ctx, [["linear", linearStep]]);
    expect(reads(linear)).toEqual(["whole", at(9, 50).toISOString()]);
    expect(linear.calls).toHaveLength(2);
    // Every other step of the run that lists tasks asks the same short question, never for the project again.
    expect((await (await services(ctx)).tracker.list()).map((t) => t.identifier).sort()).toEqual([a.identifier, b.identifier].sort());
    expect(reads(linear).at(-1)).toBe(at(10, 20).toISOString());

    // A teammate moves one in Linear and adds another: the next run brings back exactly those two, merged into PMX's copy.
    clock.now = at(10, 45);
    linear.touch(b.id, { stateId: "S-cxl" });
    const c = linear.seed("Spec the audit log", [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "S"]], { stateId: "S-todo" });
    clock.now = at(11, 0);
    const before = linear.calls.length;
    const tasks = await (await services(ctx)).tracker.list();
    expect(linear.calls.length - before).toBe(1);
    expect(tasks.map((t) => t.identifier).sort()).toEqual([a.identifier, c.identifier].sort());
    expect((await readSnapshot())!.issues.map((n: any) => [n.identifier, n.state.type]).sort()).toEqual([[a.identifier, "unstarted"], [b.identifier, "canceled"], [c.identifier, "unstarted"]].sort());

    // PMX's own change is in its copy at once, so its page shows it before the next read.
    const made = await (await services(ctx)).tracker.createInbox({ title: "Spec the export", description: "d", category: "spec", size: "S", sources: [] });
    await (await services(ctx)).tracker.setStatus(a.id, "claimed");
    const copy = (await readSnapshot())!.issues;
    expect(copy.find((n: any) => n.id === made.id)).toMatchObject({ title: "Spec the export" });
    expect(copy.find((n: any) => n.id === a.id).labels.nodes.map((l: any) => l.name)).toContain("claimed");

    // An issue deleted in Linear never shows up as changed: the day's first read is whole, and drops it.
    linear.issues.delete(c.id);
    clock.now = at(23, 30);
    await linearStep(ctx);
    expect(reads(linear).at(-1)).not.toBe("whole");
    expect((await readSnapshot())!.issues.map((n: any) => n.identifier)).toContain(c.identifier);
    clock.now = at(0, 15, 28);
    await linearStep(ctx);
    expect(reads(linear).at(-1)).toBe("whole");
    expect((await readSnapshot())!.issues.map((n: any) => n.identifier)).not.toContain(c.identifier);
    // A copy the Claude app's sync left (or another project's) is never built on.
    await relaySnapshot([issueNode("ACME-99", [["pmx-status", "ready"]])]);
    const { saveDirect } = await import("../src/linear/direct.js");
    await saveDirect({ ...(await readDirect()), projectId: null });
    clock.now = at(0, 45, 28);
    await linearStep(ctx);
    expect(reads(linear).at(-1)).toBe("whole");
    expect((await readSnapshot())!.issues.map((n: any) => n.identifier)).not.toContain("ACME-99");
  });

  it("if Linear won't answer the changes-only question, PMX reads the whole project, as it did before", async () => {
    const { linear, ctx, clock } = await keyMac();
    const a = linear.seed("Spec the bulk editor", [["pmx-status", "ready"]]);
    await linearStep(ctx);
    const good = linear.f;
    ctx.fetch = (async (u: any, i: any) => (JSON.parse(i.body).variables.since ? new Response(JSON.stringify({ errors: [{ message: "Argument Validation Error", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] })) : good(u, i))) as typeof fetch;
    clock.now = at(10, 30);
    const b = linear.seed("Spec the audit log", [["pmx-status", "ready"]]);
    expect((await (await services(ctx)).tracker.list()).map((t) => t.identifier).sort()).toEqual([a.identifier, b.identifier].sort());
    expect(reads(linear).at(-1)).toBe("whole");
    expect((await readSnapshot())!.issues).toHaveLength(2);
  });

  it("backs off on a rate-limit answer, says so once, and asks again only when Linear said it may", async () => {
    const { linear, ctx, clock } = await keyMac();
    linear.seed("Spec the bulk editor", [["pmx-status", "ready"]]);
    await linearStep(ctx);
    clock.now = at(10, 30);
    linear.mode.now = "limited";
    linear.mode.resetAt = at(11, 10);
    const steps: [string, typeof linearStep][] = [["linear", linearStep], ["pull", async (c) => { await (await services(c)).tracker.list(); return null; }], ["evidence", async (c) => { await (await services(c)).tracker.list(); return null; }]];
    const before = linear.calls.length;
    // One request met the limit; the rest of the run asked nothing. Said once, as no step's failure.
    expect(await runTick(ctx, steps)).toEqual(["linear: Linear asked PMX to slow down (its rate limit). PMX asks again after 11:10; nothing is lost, it waits."]);
    expect(linear.calls.length - before).toBe(1);
    expect((await readDirect()).problem).toMatchObject({ kind: "rate-limited", until: at(11, 10).toISOString(), told: true });
    // The next run is still inside the wait: nothing asked, nothing said again.
    clock.now = at(11, 0);
    expect(await runTick(ctx, steps)).toEqual([]);
    expect(linear.calls.length - before).toBe(1);
    await expect((await services(ctx)).tracker.list()).rejects.toThrow(LinearError);
    // The copy PMX has stays, and health says why it's a little old instead of calling the key broken.
    expect((await directHealth(ctx.team, clock.now)).detail).toMatch(/^Linear with your API key: read 1h ago, and again with every background run; Linear asked PMX to slow down/);
    // After the time Linear gave, PMX asks again, and the wait is forgotten.
    linear.mode.now = "ok";
    clock.now = at(11, 30);
    expect(await runTick(ctx, steps)).toEqual([]);
    expect(linear.calls.length - before).toBe(4);
    expect((await readDirect()).problem).toBeNull();
  });

  it("a key Linear no longer accepts is said plainly in the run's log, one notification, doctor, status and the checklist, and PMX never falls back to the Claude app's sync", async () => {
    const { linear, keychain, ctx, clock } = await keyMac();
    linear.seed("Spec the bulk editor", [["pmx-status", "ready"]]);
    await linearStep(ctx);
    // An old copy from the Claude app's days is still on disk; it must not be what PMX quietly works from.
    clock.now = at(10, 30);
    linear.mode.now = "rejected";
    const steps: [string, typeof linearStep][] = [["linear", linearStep], ["synthesize", async (c) => { await (await services(c)).tracker.list(); return null; }], ["pull", async (c) => { await (await services(c)).tracker.createInbox({ title: "x", description: "d", category: "spec", size: "S", sources: [] }); return null; }]];
    const before = linear.calls.length;
    const KEY_GONE = "Linear no longer accepts this Mac's API key: it was revoked, or it was never a key. Nothing reaches Linear until you paste a new one (pmx linear key) or go back to the Claude app's sync (pmx linear key --remove, then /pmx-schedule in the Claude app).";
    // One line for the whole run, not one failure per step, and one request to Linear.
    expect(await runTick(ctx, steps)).toEqual([`linear: ✘ ${KEY_GONE}`]);
    expect(linear.calls.length - before).toBe(1);
    // Every run's log says it; the notification comes once.
    const notices: string[] = [];
    const tell = async (_t: string, msg: string) => void notices.push(msg);
    const { saveDirect } = await import("../src/linear/direct.js");
    await saveDirect({ ...(await readDirect()), problem: { ...(await readDirect()).problem!, told: false } });
    expect(await sayLinearProblem({ notify: tell })).toBe(`✘ ${KEY_GONE}`);
    expect(await sayLinearProblem({ notify: tell })).toBe(`✘ ${KEY_GONE}`);
    expect(notices).toEqual(["Linear no longer accepts this Mac's API key, so nothing reaches Linear. Paste a new one: pmx linear key. Or go back to the Claude app's sync: pmx linear key --remove."]);
    clock.now = at(11, 0);
    expect(await runTick(ctx, steps)).toEqual([`linear: ✘ ${KEY_GONE}`]);
    expect(linear.calls.length - before).toBe(2);

    // Never the relay: the tracker is still Linear itself, nothing was queued for the Claude app, and it needs no sync task.
    expect((await services(ctx)).tracker.kind).toBe("linear");
    expect((await readOutbox()).ops).toEqual([]);
    expect((await neededTasks(ctx.team, keychain)).map((t) => t.id)).toEqual([COLLECT_TASK.id]);
    expect(await linearAccess(ctx.team, keychain)).toBe("key");

    // Doctor fails on it, status and the checklist say what to do, and so does PMX's page, without a command.
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: ctx.now });
    expect(checks.find((c) => c.id === "linear.direct")).toEqual({ id: "linear.direct", ok: false, level: "fail", detail: `Linear with your API key: ${KEY_GONE}` });
    expect((await pmxLinear(ctx, ["status"]))[0]).toBe(`Linear: with your API key (in this Mac's keychain): ${KEY_GONE}`);
    const cl = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: clock.now, ctx });
    const step = cl.sections.flatMap((s) => s.steps).find((s) => s.id === "linear.connected")!;
    expect(step).toMatchObject({ status: "todo", required: true, who: "you", how: "terminal", detail: `Linear with your API key: ${KEY_GONE}` });
    expect(step.do).toBe("In Terminal, run pmx linear key and paste a new Linear API key (it says where to create one). Or go back to the Claude app's hourly sync: pmx linear key --remove, then /pmx-schedule in the Claude app");
    expect(step.page).toBe("Linear no longer accepts this Mac's API key, so nothing reaches Linear. Paste a new one in Terminal, or go back to the Claude app's sync.");
    // /pmx-setup puts it on the person's list, and never takes a key in chat.
    const prompt = await setupPrompt(cl, { desktopApp: false, mcpRegistered: false, serverRunning: false });
    expect(prompt).toContain("- Never ask for, read, type or repeat a Linear API key in this chat. The user pastes theirs in Terminal, into PMX's own prompt (`pmx linear key`), and it's kept in the Mac's keychain only.");
    expect(prompt.slice(prompt.indexOf("## Last"))).toMatch(/\n\d\. Linear with your API key: Linear no longer accepts this Mac's API key[^\n]* Only the user can: in Terminal, `pmx linear key`, pasted into PMX's own prompt, never into this chat\./);
    const page = await loadPipeline(ctx, { level: "local", hours: 168, keychain });
    expect(page.health.problems).toContain("Linear no longer accepts this Mac's API key, so nothing reaches Linear and PMX can't see your team's changes. Paste a new key in Terminal, or go back to the Claude app's sync. Health, then Setup, says how.");
    expect(page.automations.find((a) => a.id === "linear")).toMatchObject({ status: "attention", statusText: "Key no longer works" });

    // A new key puts it right at once.
    linear.mode.now = "ok";
    const said = await pmxLinear(ctx, ["key"], { ask: asker({ "Linear API key": "lin_api_ANOTHERtestonlykey" }).ask });
    expect(said.join("\n")).toContain("Saved the key in this Mac's keychain.");
    expect((await readDirect()).problem).toBeNull();
    expect((await directHealth(ctx.team, clock.now)).ok).toBe(true);
    expect(await runTick(ctx, steps)).toEqual([]);
  });

  it("a key that can read but not write is told at its first change, with what it needs", async () => {
    const { linear, ctx, keychain } = await keyMac();
    const a = linear.seed("Spec the bulk editor", [["pmx-status", "ready"]]);
    await linearStep(ctx);
    linear.mode.now = "read-only";
    const t = (await services(ctx)).tracker;
    await expect(t.setStatus(a.id, "claimed")).rejects.toThrow(/This Mac's Linear key isn't allowed to do that in team ACME \(Invalid scope: `write` required\)\. PMX needs a key with Read and Write on that team/);
    // Reading still works, and doesn't hide it.
    await t.list();
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: ctx.now });
    expect(checks.find((c) => c.id === "linear.direct")).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/can read your team's project but Linear refused a change PMX made with it \(Invalid scope: `write` required\)\. PMX needs a key with Read and Write/) });
    // A change Linear takes clears it.
    linear.mode.now = "ok";
    await t.setStatus(a.id, "claimed");
    expect((await readDirect()).problem).toBeNull();
  });

  it("the background run's steps include Linear's own, before the steps that work from it", () => {
    const names = tickSteps.map(([n]) => n);
    expect(names).toContain("linear");
    for (const later of ["release", "synthesize", "company", "evidence", "pull"]) expect(names.indexOf("linear")).toBeLessThan(names.indexOf(later));
  });

  it("working hours neither delay the key's sync nor are shown as if they did", async () => {
    const { linear, keychain, ctx, clock } = await keyMac();
    await claudeTask(COLLECT_TASK);
    ctx.personal.taskHours = "weekdays";
    // Sunday, three in the morning, working hours only: the sync runs like any other.
    clock.now = new Date(2026, 10, 29, 3, 0, 0);
    linear.seed("Spec the bulk editor", [["pmx-status", "ready"]]);
    expect(await runTick(ctx, [["linear", linearStep]])).toEqual([]);
    expect((await readSnapshot())!.issues).toHaveLength(1);

    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: ctx.now });
    const steps = async (personal = ctx.personal) => (await gatherChecklist({ personal, team: ctx.team, checks, exec: mac, keychain, now: clock.now, ctx })).sections.flatMap((s) => s.steps);
    expect((await steps()).find((s) => s.id === "linear.hours")).toEqual(expect.objectContaining({
      title: "Linear syncs with every background run", status: "done", required: false,
      detail: "with your Linear API key PMX syncs Linear itself with every background run, every 30 minutes while this Mac is awake. Working hours don't apply to it: yours are for meeting collection only",
    }));
    expect((await steps({ ...ctx.personal, taskHours: "always" })).find((s) => s.id === "linear.hours")!.detail).toBe("with your Linear API key PMX syncs Linear itself with every background run, every 30 minutes while this Mac is awake. Working hours don't apply to it");
    expect((await steps()).find((s) => s.id === "linear.connected")).toMatchObject({ status: "done", detail: "Linear with your API key: read under a minute ago, and again with every background run" });

    // Choosing hours says what they're for here, and `pmx schedule` shows no Linear hours.
    const weekdays = await setTaskHours(ctx.personal, "weekdays", { direct: true });
    expect(weekdays).toBe("PMX's meeting collection in the Claude app now works on weekdays only, at 12:30 and 17:30; on other days each run starts briefly and stops. Linear isn't affected by this setting: with your API key PMX syncs it with every background run, every 30 minutes while this Mac is awake. Nothing changes in the Claude app.");
    const schedule = await formatTasks(ctx.team, keychain, "weekdays");
    expect(schedule).toContain("Hours: meeting collection works on weekdays only, as you chose. (Back to every day: pmx schedule --hours always.) Linear isn't affected by this setting: with your API key PMX syncs it with every background run, every 30 minutes while this Mac is awake.");
    expect(schedule).not.toMatch(/the Linear sync every hour/);
    // On the Claude app's sync the same setting still says the sync's hours, as before.
    expect(await formatTasks(ctx.team, memoryKeychain(), "weekdays")).toContain("Hours: working hours only, as you chose: the Linear sync every hour on weekdays from 8:00 to 19:00");
    // The page is told which it is, and its Schedule card says the same.
    const page = await loadPipeline(ctx, { level: "local", hours: 168, keychain });
    expect(page.freshness.linearVia).toBe("direct");
    expect(page.automations.find((a) => a.id === "linear")).toMatchObject({ status: "ok", cadence: "every background run, and at once when you approve or move something", where: "Linear" });
    const html = await readFile(join(import.meta.dirname, "..", "app-skills", "pmx-flow", "pipeline.html"), "utf8");
    expect(html).toContain("Linear isn't affected by this setting: with your API key PMX syncs it with every background run, every 30 minutes while this Mac is awake.");
    expect(html).toContain("const relayOn = () => !linearDirect() &&");
  });

  it("the head of product's roll-up: setup and the checklist say the key needs Read on those teams, and a team it can't read is said clearly", async () => {
    const company = { teams: [{ name: "Payments", teamKey: "PAY", projectId: "proj-pay" }, { name: "Growth", teamKey: "GRO", projectId: "proj-gro" }], machine: "lee" };
    const team = { ...TEAM, company } as TeamConfig;
    // Setup's words, on the roll-up's Mac only.
    expect(rollupTeams(team, { handle: "lee" })).toEqual([{ name: "Payments", teamKey: "PAY" }, { name: "Growth", teamKey: "GRO" }]);
    expect(rollupTeams(team, { handle: "dana" })).toEqual([]);
    expect(keyHelp(team, { rollup: rollupTeams(team, { handle: "lee" }) }).join("\n")).toContain("This Mac also runs your company's roll-up, which reads other teams' PMX projects: give the key Read on Payments (PAY), Growth (GRO) too.");
    expect(keyHelp(team).join("\n")).not.toMatch(/roll-up/);

    // The key sees Payments but not Growth.
    const { linear, keychain, ctx, clock } = await keyMac({ team: { company }, linear: { teams: [{ key: "ACME", name: "Acme Product" }, { key: "PAY", name: "Payments" }], projects: [{ id: "proj-1", name: "PMX" }, { id: "proj-pay", name: "PMX" }] } });
    const check = await checkLinearKey(ctx, FAKE_KEY, { rollup: rollupTeams(ctx.team, { handle: "lee" }) });
    expect(check.ok).toBe(true);
    expect(linear.calls[0]!.vars.keys).toEqual(["ACME", "PAY", "GRO"]);
    expect(check.lines.at(-1)).toBe("It can't see Growth (GRO), so the company roll-up leaves that team out: the roll-up needs a key with Read on it too.");

    // The roll-up reads what it can, and says which team it couldn't and what the key needs.
    linear.seed("Spec the refund flow", [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "M"]], { project: { id: "proj-pay" } });
    const r = await rollup(ctx, await services(ctx));
    expect(r.teams).toEqual([
      { name: "Payments", tasks: 1 },
      { name: "Growth", tasks: 0, error: "this Mac's Linear key can't read team GRO's PMX project. The roll-up needs a key with Read on GRO too: create one in Linear (Settings → Account → Security & access) and paste it with pmx linear key" },
    ]);
    expect((await loadState()).rollupUnread).toEqual({ at: clock.now.toISOString(), teams: [{ name: "Growth", teamKey: "GRO", why: "the key has no Read on team GRO" }] });
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: ctx.now });
    const steps = async () => (await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: clock.now, ctx })).sections.flatMap((s) => s.steps);
    expect((await steps()).find((s) => s.id === "linear.rollup")).toMatchObject({
      status: "warn", required: false,
      detail: "this Mac's Linear key couldn't read Growth (GRO) at the last roll-up (Nov 27), so that team was left out: the key has no Read on team GRO",
      do: "In Linear, create a key that also has Read on Growth (GRO) (Settings → Account → Security & access), then run pmx linear key and paste it",
    });
    // A key Linear doesn't forbid the team to reads it, and the step says what the key needs to keep.
    const { saveState } = await import("../src/core/state.js");
    await saveState({ ...(await loadState()), rollupUnread: null });
    expect((await steps()).find((s) => s.id === "linear.rollup")).toMatchObject({ status: "done", detail: "reads Payments (PAY), Growth (GRO) with this Mac's Linear key, which needs Read on each of them" });
    // Without a key the roll-up can't run at all, and the step says a key is what it needs.
    const noKey = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks: checks.filter((c) => c.id !== "linear.direct"), exec: mac, keychain: memoryKeychain(), now: clock.now, ctx });
    expect(noKey.sections.flatMap((s) => s.steps).find((s) => s.id === "linear.rollup")).toMatchObject({ status: "todo", detail: expect.stringMatching(/The Claude app's sync covers one project only, so the roll-up needs your own Linear API key, with Read on those teams$/) });
  });

  it("a Mac on the Claude app's sync whose PM was never asked is told once that a key is the usual way, and never after choosing", async () => {
    const keychain = memoryKeychain();
    const { ctx } = await onTeam({ keychain });
    await relaySnapshot([]);
    const checks = await runDoctor({ team: ctx.team, personal: ctx.personal, keychain, launchd: fakeLaunchd(), exec: mac, now: ctx.now });
    const key = async () => (await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx })).sections.flatMap((s) => s.steps).find((s) => s.id === "linear.key");
    expect(await key()).toMatchObject({ status: "todo", required: false, who: "you", how: "terminal", do: expect.stringMatching(/^In Terminal, run pmx linear key: it says where to create the key and what to choose\. Return there keeps the Claude app's sync, and this step goes away$/) });
    expect((await pmxLinear(ctx, ["status"]))[0]).toMatch(/PMX's usual way is your own Linear API key, which syncs with every background run: pmx linear key$/);
    const cl = await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx });
    const last = async (c: typeof cl) => { const t = await setupPrompt(c, { desktopApp: false, mcpRegistered: false, serverRunning: false }); return t.slice(t.indexOf("## Last")); };
    expect(await last(cl)).toMatch(/\n\d\. Optional, and only the user can: PMX's usual way to Linear is their own Linear API key[^\n]*They run `pmx linear key` in Terminal[^\n]*never into this chat\./);
    // They press Return at the question: no more of it, anywhere.
    await pmxLinear(ctx, ["key"]);
    expect(await key()).toBeUndefined();
    expect((await pmxLinear(ctx, ["status"]))[0]).not.toMatch(/usual way/);
    expect(await last(await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks, exec: mac, keychain, now: NOW, ctx }))).not.toMatch(/usual way/);
    expect(await formatTasks(ctx.team, keychain)).not.toMatch(/usual way/);
    expect((await stat(paths.state())).isFile()).toBe(true);
  });
});

describe("applying queued changes directly (LINEAR-2)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("claude-home-"); });

  it("a shared skill document stays queued and is said, since only the Claude app's sync carries documents", async () => {
    const linear = fakeLinear({ now: () => NOW });
    const keychain = memoryKeychain();
    const { ctx } = await onTeam({ keychain, fetch: linear.f });
    await relaySnapshot([]);
    const { enqueueSkillDoc } = await import("../src/tracker/relay.js");
    await enqueueSkillDoc("launch-note", "# Launch note\nHow we write one.", ctx.now);
    const r = await adoptKey(ctx, FAKE_KEY);
    expect(r.lines.join("\n")).toMatch(/1 shared skill document\(s\) still wait: sharing a skill through Linear goes through the Claude app's sync only\. `pmx linear outbox` lists them; `pmx linear outbox drop <ID>` drops one\./);
    expect((await readOutbox()).ops.map((o) => o.kind)).toEqual(["upsert-skill-doc"]);
    // A later pass leaves it alone, and counts no refusal against it.
    expect(await drainOutbox(ctx, directFor(ctx, FAKE_KEY))).toEqual({ applied: 0, waiting: 1, lines: [] });
    expect((await readOutbox()).ops[0]!.failures).toBeUndefined();
  });
});
