// R24: a team repo that isn't on GitHub keeps drafts as local branches, and accepting one squashed it onto this Mac's
// base branch only, so accepted drafts never reached the team's main. Now the accept pushes the base to origin,
// fast-forward only and never forced; when that can't happen the accept stands and the answer says so, once.
// D2-2: when the team's repo had newer work, the accept stayed on this Mac, a plain `git push` was refused, and the
// background run stopped taking the team's settings without a word. Now the accept goes on top of the team's work and
// is pushed; the background run does the same for older accepts; and what PMX can't share shows in Needs you, `pmx
// status` and `pmx doctor` with what to run. A PM's own commits on main are never pushed for them.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runStatus } from "../src/commands/status.js";
import { teamSyncProblem, teamSyncStep } from "../src/commands/team-sync.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { exec, type Exec } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { localHost, unsharedWork } from "../src/core/host.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { services } from "../src/core/services.js";
import { loadState } from "../src/core/state.js";
import type { Task } from "../src/core/types.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { pull } from "../src/pull/pull.js";
import { decide, loadQueue } from "../src/review/queue.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const DRAFT = "pmx/task/PMX-31-spec-sso";

/** A team repo with a bare origin (not GitHub), and a local draft for PMX-31. */
async function withOrigin(): Promise<{ repo: string; origin: string }> {
  const { repo, origin } = await pmxRepo({}, { remote: true });
  await git(repo, "checkout", "-q", "-b", DRAFT);
  await mkdir(join(repo, "outputs", "spec"), { recursive: true });
  await writeFile(join(repo, "outputs", "spec", "PMX-31.md"), "# Spec SSO\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "PMX-31: Spec SSO");
  await git(repo, "checkout", "-q", "main");
  return { repo, origin: origin! };
}
const tip = (dir: string, ref = "main") => git(dir, "rev-parse", ref);
const subjects = (dir: string, ref = "main") => git(dir, "log", "--format=%s", ref).then((s) => s.split("\n"));
const onDisk = (p: string) => stat(p).then(() => true, () => false);

/** A teammate's clone of origin, which pushes one file to origin's main. */
async function teammatePushes(origin: string, file: string, text: string, message = "theirs"): Promise<string> {
  const mate = join(await tmp(), "mate");
  await git(dirname(mate), "clone", "-q", origin, mate);
  await mkdir(dirname(join(mate, file)), { recursive: true });
  await writeFile(join(mate, file), text);
  await git(mate, "add", "-A");
  await git(mate, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", message);
  await git(mate, "push", "-q", "origin", "main");
  return mate;
}

/** A commit on this Mac's main as PMX's accept writes it, as an older PMX left it unpushed (RL4). */
async function oldAccept(repo: string, id: string): Promise<void> {
  await mkdir(join(repo, "outputs", "spec"), { recursive: true });
  await writeFile(join(repo, "outputs", "spec", `${id}.md`), `# ${id}\n`);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", `Accept pmx/task/${id}-old-spec`);
}

const onlyGit: Exec = (cmd, args, o) => (cmd === "git" ? exec(cmd, args, o) : Promise.resolve({ code: 1, stdout: "", stderr: "" }));
const doctorOf = async (ctx: Awaited<ReturnType<typeof testCtx>>) =>
  (await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: onlyGit, engine: async () => [] })).find((c) => c.id === "team.push");
const q = (repo: string) => `'${repo}'`;

describe("accepting a draft on a team repo that isn't on GitHub (R24)", () => {
  beforeEach(freshHome);

  it("pushes the team's base to origin, so the accepted draft reaches every Mac", async () => {
    const { repo, origin } = await withOrigin();
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({});
    expect(await tip(origin)).toBe(await tip(repo));
    expect(await git(origin, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
  });

  it("an origin it can't reach keeps the accept here and says so; a repo with no origin has nothing to push", async () => {
    const { repo } = await withOrigin();
    await git(repo, "remote", "set-url", "origin", join(await tmp(), "gone.git"));
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({ unpushed: "The accepted draft is only on this Mac for now: PMX couldn't reach your team's repo. PMX's next background run tries again." });
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
    expect((await loadState()).teamPush).toMatchObject({ why: "unreachable" });

    const { repo: alone } = await pmxRepo();
    await git(alone, "checkout", "-q", "-b", DRAFT);
    await writeFile(join(alone, "x.md"), "draft\n");
    await git(alone, "add", "-A");
    await git(alone, "commit", "-q", "-m", "draft");
    await git(alone, "checkout", "-q", "main");
    expect(await localHost(new Git(alone)).accept(DRAFT)).toEqual({});
  });
});

describe("an accept while the team's repo has newer work (D2-2)", () => {
  beforeEach(freshHome);

  it("goes on top of the team's work and is pushed, never forced, so the draft is in the team's repo", async () => {
    const { repo, origin } = await withOrigin();
    // A teammate's accept reached origin first.
    await teammatePushes(origin, "theirs.md", "a teammate's accept\n");
    const theirs = await tip(origin);
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({});
    // Origin has both, the teammate's first: a fast-forward of what it had.
    expect(await tip(origin)).toBe(await tip(repo));
    expect((await subjects(origin)).slice(0, 3)).toEqual([`Accept ${DRAFT}`, "theirs", "init"]);
    expect(await git(origin, "merge-base", "--is-ancestor", theirs, "main").then(() => true, () => false)).toBe(true);
    expect(await git(origin, "show", "main:outputs/spec/PMX-31.md")).toBe("# Spec SSO");
    // The PM's checkout has the team's newer work too, with nothing left over from the rebase.
    expect(await readFile(join(repo, "theirs.md"), "utf8")).toBe("a teammate's accept\n");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect((await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
    expect((await loadState()).teamPush).toMatchObject({ why: null });
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toBeNull();
  });

  it("an unsaved edit of the PM's stays as it was, and the accept still reaches the team", async () => {
    const { repo, origin } = await withOrigin();
    await teammatePushes(origin, "theirs.md", "a teammate's accept\n");
    await writeFile(join(repo, "CLAUDE.md"), "my own edit\n");
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({});
    expect(await git(origin, "show", "main:outputs/spec/PMX-31.md")).toBe("# Spec SSO");
    expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toBe("my own edit\n");
    expect(await tip(repo)).toBe(await tip(origin));
  });

  it("a clash leaves every repo as it was, keeps the accept, and Needs you, pmx status and doctor say what to run", async () => {
    const { repo, origin } = await withOrigin();
    // A teammate wrote the same file differently: neither a rebase nor a merge fits both.
    await teammatePushes(origin, "outputs/spec/PMX-31.md", "# Their SSO spec\n");
    const theirs = await tip(origin);
    const before = await tip(repo);
    const r = await localHost(new Git(repo)).accept(DRAFT);
    const pullCmd = `git -C ${q(repo)} pull --rebase origin main`, pushCmd = `git -C ${q(repo)} push origin main`;
    expect(r).toEqual({ unpushed: `The accepted draft is only on this Mac: it clashes with newer work in your team's repo, so PMX left both as they were. To share it, run ${pullCmd} in Terminal, settle the clash as git says, then run ${pushCmd}.` });
    // Origin untouched; this Mac's main holds the accept on top of what it had, and no rebase or merge is left open.
    expect(await tip(origin)).toBe(theirs);
    expect(await git(repo, "rev-parse", "main~1")).toBe(before);
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    for (const f of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) expect(await onDisk(join(repo, ".git", f))).toBe(false);
    expect((await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
    expect((await loadState()).teamPush).toMatchObject({ why: "clash" });

    const text = `1 accepted draft is only on this Mac: it clashes with newer work in your team's repo, so PMX left it as it was. Run ${pullCmd}, settle the clash as git says, then run ${pushCmd}`;
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toEqual({ needsYou: true, text });
    const ctx = await testCtx({ repo });
    expect(await doctorOf(ctx)).toMatchObject({ ok: false, level: "warn", detail: text });
    const board = await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain });
    expect(board.health.items.map((i) => i.text)).toContain(text);
    expect(board.needsYou!.fixes).toBeGreaterThanOrEqual(1);
    // The team's page never carries one Mac's git state.
    expect((await loadPipeline(ctx, { level: "shared", hours: 168, keychain: ctx.keychain })).health.items.map((i) => i.text)).not.toContain(text);
    expect((await runStatus(ctx)).split("\n")).toContain(`Team repo: ✘ ${text}`);

    // The background run doesn't quietly work from the stale checkout: it says the same, and the team-repo check fails.
    expect(await teamSyncStep(ctx)).toBe(`team repo: ${text}; working from what's checked out until then`);
    expect((await loadState()).teamSync?.result).toBe("failed: accepted drafts on main aren't in your team's repo");
    expect(await tip(origin)).toBe(theirs);
  });

  it("when the accepts don't replay one by one but fit together, PMX merges, and its merge counts as its own", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    // Two accepts on this Mac: one changes CLAUDE.md, the next puts it back. The team changed the same line meanwhile.
    const was = await readFile(join(repo, "CLAUDE.md"), "utf8");
    await writeFile(join(repo, "CLAUDE.md"), "accepted change\n");
    await writeFile(join(repo, "a.md"), "a\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Accept pmx/task/PMX-1-a");
    await writeFile(join(repo, "CLAUDE.md"), was);
    await writeFile(join(repo, "b.md"), "b\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "Accept pmx/task/PMX-2-b");
    await teammatePushes(origin!, "CLAUDE.md", "the team's change\n");
    const ctx = await testCtx({ repo });
    expect(await teamSyncStep(ctx)).toBe("team repo: put 2 accepted drafts from this Mac in your team's repo; pulled the latest main");
    expect(await git(origin!, "log", "-1", "--format=%s%n%P", "main").then((s) => s.split("\n"))).toEqual(["Merge your team's main under accepted drafts (PMX)", expect.stringMatching(/^\w{40} \w{40}$/)]);
    for (const f of ["a.md", "b.md"]) expect(await git(origin!, "show", `main:${f}`)).toBeTruthy();
    expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toBe("the team's change\n");
    expect(await tip(repo)).toBe(await tip(origin!));
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toBeNull();
  });

  it("Linear says where the draft is, and the answer says nothing more when it reached the team", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const task: Task = {
      id: "lin-31", identifier: "PMX-31", title: "Spec SSO",
      // Quoted inline, as tasks before PRIV-6 were, so this Mac can run it without a synthesis receipt.
      description: "Admins share a password.\n\n- [T1] Globex call: we share one admin password\n- [S1] #feedback: an SSO ask\n\npmx:source T1\npmx:source S1",
      url: "https://linear.app/acme/issue/PMX-31", category: "spec", size: "S", status: "ready", priority: 2, agent: null, sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
    };
    const twin: Task = { ...task, id: "lin-32", identifier: "PMX-32", title: "Spec SCIM", url: "https://linear.app/acme/issue/PMX-32" };
    const tracker = memoryTracker([task, twin]);
    const runtime = mockRuntime(async (r) => {
      const out = r.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(r.cwd, out)), { recursive: true });
      await writeFile(join(r.cwd, out), "# Spec\n\n## Problem\n\nAdmins share a password [T1].\n\n## Evidence\n\n- One shared password [T1]\n- An SSO ask [S1]\n\n## Validated by\n\nNot validated yet [T1].\n\n## Proposal\n\nSSO.\n\n## Success metrics\n\n- No shared passwords.\n\n## Open questions\n\nNone.\n");
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime });
    const svc = await services(ctx, { tracker });
    expect((await pull(ctx, svc, { dryRun: false })).ran?.outcome).toBe("ok");
    expect((await pull(ctx, svc, { dryRun: false })).ran?.outcome).toBe("ok");
    const { items, host } = await loadQueue(ctx, svc);
    expect(host.kind).toBe("local");
    const [first, second] = ["PMX-31", "PMX-32"].map((id) => items.find((i) => i.task.identifier === id)!);
    const draftPath = (await git(repo, "diff", "--name-only", `main...${second!.prId}`)).split("\n").find((f) => f.startsWith("outputs/"))!;

    // A teammate's accept reached origin's main first: the accept still lands there, and Linear says only who accepted.
    await teammatePushes(origin!, "theirs.md", "a teammate's accept\n");
    expect(await decide(ctx, svc, host, first!, "accepted")).toBe("PMX-31 accepted.");
    expect(tracker.comments.get("lin-31")!.at(-1)).toBe("Accepted by ana.");
    expect(await git(origin!, "log", "-1", "--format=%s", "main")).toMatch(/^Accept pmx\/task\/PMX-31-/);

    // A teammate wrote PMX-32's file differently: the accept stays here, and Linear doesn't point at the team repo.
    await teammatePushes(origin!, draftPath, "# Their spec\n");
    const msg = await decide(ctx, svc, host, second!, "accepted");
    expect(msg).toMatch(/^PMX-32 accepted\. The accepted draft is only on this Mac: it clashes with newer work in your team's repo/);
    expect(tracker.comments.get("lin-32")!.at(-1)).toBe("Accepted by ana. The accepted draft is on ana's Mac until it's pushed to the team repo.");
    expect(tracker.tasks.get("lin-32")!.status).toBe("done");

    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: onlyGit, engine: async () => [] });
    expect(checks.find((c) => c.id === "repo.host")).toMatchObject({ ok: true, detail: expect.stringMatching(/^team repo isn't on GitHub, so drafts wait as local branches .* \(fast-forward only, never forced\)$/) });
    expect(checks.find((c) => c.id === "team.push")).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/^1 accepted draft is only on this Mac: it clashes/) });
  });
});

describe("the background run shares accepts that never reached the team's repo (D2-2)", () => {
  beforeEach(freshHome);

  it("pushes accepts an older PMX left on this Mac, whether or not the team's repo moved since", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    // Before R24, accepts stayed on the Mac: Needs you has nothing to ask yet, but status and doctor say they wait.
    await oldAccept(repo, "PMX-1");
    const ctx = await testCtx({ repo, now: new Date("2026-11-06T10:00:00Z") });
    const pending = `1 accepted draft is only on this Mac until PMX's next background run pushes it to your team's repo (or run: git -C ${q(repo)} pull --rebase origin main && git -C ${q(repo)} push origin main)`;
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toEqual({ needsYou: false, text: pending });
    expect(await doctorOf(ctx)).toMatchObject({ ok: false, level: "warn", detail: pending });
    expect((await runStatus(ctx)).split("\n")).toContain(`Team repo: ${pending}`);
    expect(await teamSyncStep(ctx)).toBe("team repo: put 1 accepted draft from this Mac in your team's repo");
    expect(await tip(origin!)).toBe(await tip(repo));
    expect(await doctorOf(ctx)).toMatchObject({ ok: true, detail: "every accept on this Mac is in your team's repo" });

    // Two more, while a teammate's work reached the team's repo: they go on top of it.
    await oldAccept(repo, "PMX-2");
    await oldAccept(repo, "PMX-3");
    await teammatePushes(origin!, "theirs.md", "a teammate's accept\n");
    const later = await testCtx({ repo, now: new Date("2026-11-06T10:20:00Z") });
    expect(await teamSyncStep(later)).toBe("team repo: put 2 accepted drafts from this Mac in your team's repo; pulled the latest main");
    expect((await subjects(origin!)).slice(0, 5)).toEqual(["Accept pmx/task/PMX-3-old-spec", "Accept pmx/task/PMX-2-old-spec", "theirs", "Accept pmx/task/PMX-1-old-spec", "init"]);
    expect(await tip(repo)).toBe(await tip(origin!));
    expect(await readFile(join(repo, "theirs.md"), "utf8")).toBe("a teammate's accept\n");
    expect((await loadState()).teamSync?.result).toBe("ok");
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toBeNull();
  });

  it("takes the team's settings again once its accepts are pushed", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    await oldAccept(repo, "PMX-1");
    const mate = await teammatePushes(origin!, "theirs.md", "a teammate's accept\n");
    // Before D2-2 this pass said "couldn't fast-forward main … working from what's checked out", and every one after it.
    const ctx = await testCtx({ repo, now: new Date("2026-11-06T10:00:00Z") });
    expect(await teamSyncStep(ctx)).toBe("team repo: put 1 accepted draft from this Mac in your team's repo; pulled the latest main");

    // The team adds a kind of work: the next pass takes it, as on any other Mac.
    await git(mate, "pull", "-q", "--ff-only", "origin", "main");
    const cfgPath = join(mate, "pmx.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.categories = { ...(cfg.categories ?? DEFAULT_TEAM.categories), "win-loss": { skill: "win-loss" } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await git(mate, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "Add win-loss");
    await git(mate, "push", "-q", "origin", "main");
    const later = await testCtx({ repo, now: new Date("2026-11-06T10:20:00Z") });
    expect(await teamSyncStep(later)).toBe("team repo: pulled the latest main; new kinds of work from your team: win-loss");
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).categories["win-loss"]).toEqual({ skill: "win-loss" });
    expect((await loadState()).teamSync).toMatchObject({ result: "ok", okAt: "2026-11-06T10:20:00.000Z" });
    expect(teamSyncProblem(await loadState(), new Date("2026-11-09T10:00:00Z"))).toBeNull();
  });

  it("never pushes a PM's own commit on main: Needs you asks instead, with what to run", async () => {
    const { repo, origin } = await withOrigin();
    // The PM committed a note of their own on main, then accepted a draft.
    await writeFile(join(repo, "my-notes.md"), "mine\n");
    await git(repo, "add", "my-notes.md");
    await git(repo, "commit", "-q", "-m", "My notes");
    const own = await git(repo, "rev-parse", "--short=7", "HEAD");
    const theirs = await tip(origin);
    const both = `git -C ${q(repo)} pull --rebase origin main && git -C ${q(repo)} push origin main`;
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({ unpushed: `The accepted draft is only on this Mac: your main there also has commits of your own (${own} "My notes"), and PMX never pushes those for you. To push everything main has, run ${both} in Terminal.` });
    expect(await tip(origin)).toBe(theirs);
    const text = `Your main on this Mac has 1 commit of your own (${own} "My notes") and 1 accepted draft that your team's repo doesn't, and PMX never pushes your own commits for you: a push sends every commit main has. To push them all, run: ${both}`;
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toEqual({ needsYou: true, text });

    // The background run doesn't push it either. With nothing new from the team, it goes on as usual and says why.
    const ctx = await testCtx({ repo });
    expect(await teamSyncStep(ctx)).toBe(`team repo: ${text}`);
    expect(await tip(origin)).toBe(theirs);
    expect((await loadState()).teamSync?.result).toBe("ok");
    const board = await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain });
    expect(board.health.items.map((i) => i.text)).toContain(text);
    expect(await doctorOf(ctx)).toMatchObject({ ok: false, level: "warn", detail: text });

    // Once the team moved, this Mac is behind and says so, still without pushing.
    await teammatePushes(origin, "theirs.md", "a teammate's accept\n");
    const moved = await tip(origin);
    const later = await testCtx({ repo, now: new Date("2026-11-06T10:20:00Z") });
    expect(await teamSyncStep(later)).toBe(`team repo: ${text}; working from what's checked out until then`);
    expect(await tip(origin)).toBe(moved);
    expect((await loadState()).teamSync?.result).toBe("failed: your own commits on main aren't in your team's repo");

    // Once the PM runs it, everything is shared and nothing is left to say.
    await exec("sh", ["-c", both]).then((r) => expect(r.code, r.stderr).toBe(0));
    expect(await git(origin, "show", "main:my-notes.md")).toBe("mine");
    expect(await unsharedWork(new Git(repo), (await loadState()).teamPush)).toBeNull();
  });
});
