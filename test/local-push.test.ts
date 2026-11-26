// R24: a team repo that isn't on GitHub keeps drafts as local branches, and accepting one squashed it onto this Mac's
// base branch only, so accepted drafts never reached the team's main. Now the accept pushes the base to origin,
// fast-forward only and never forced; when that can't happen the accept stands and the answer says so, once.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { exec, type Exec } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { localHost } from "../src/core/host.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
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

describe("accepting a draft on a team repo that isn't on GitHub (R24)", () => {
  beforeEach(freshHome);

  it("pushes the team's base to origin, so the accepted draft reaches every Mac", async () => {
    const { repo, origin } = await withOrigin();
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({});
    expect(await tip(origin)).toBe(await tip(repo));
    expect(await git(origin, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
  });

  it("never pushes over newer work: the accept stands on this Mac, and one sentence says it isn't shared yet", async () => {
    const { repo, origin } = await withOrigin();
    // A teammate's accept reached origin first.
    const mate = join(await tmp(), "mate");
    await git(dirname(mate), "clone", "-q", origin, mate);
    await writeFile(join(mate, "theirs.md"), "a teammate's accept\n");
    await git(mate, "add", "-A");
    await git(mate, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "theirs");
    await git(mate, "push", "-q", "origin", "main");
    const theirs = await tip(origin);
    const r = await localHost(new Git(repo)).accept(DRAFT);
    expect(r).toEqual({ unpushed: "The accepted draft is only on this Mac until you run git push in your team repo: your team's repo has newer work, so PMX didn't push over it." });
    expect(await tip(origin)).toBe(theirs);
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
  });

  it("an origin it can't reach keeps the accept here and says so; a repo with no origin has nothing to push", async () => {
    const { repo } = await withOrigin();
    await git(repo, "remote", "set-url", "origin", join(await tmp(), "gone.git"));
    expect(await localHost(new Git(repo)).accept(DRAFT)).toEqual({ unpushed: "The accepted draft is only on this Mac until you run git push in your team repo: PMX couldn't reach your team's repo." });
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);

    const { repo: alone } = await pmxRepo();
    await git(alone, "checkout", "-q", "-b", DRAFT);
    await writeFile(join(alone, "x.md"), "draft\n");
    await git(alone, "add", "-A");
    await git(alone, "commit", "-q", "-m", "draft");
    await git(alone, "checkout", "-q", "main");
    expect(await localHost(new Git(alone)).accept(DRAFT)).toEqual({});
  });

  it("the accept's answer says it once when the push didn't land, and doctor names the mode", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const task: Task = {
      id: "lin-31", identifier: "PMX-31", title: "Spec SSO",
      // Quoted inline, as tasks before PRIV-6 were, so this Mac can run it without a synthesis receipt.
      description: "Admins share a password.\n\n- [T1] Globex call: we share one admin password\n- [S1] #feedback: an SSO ask\n\npmx:source T1\npmx:source S1",
      url: "https://linear.app/acme/issue/PMX-31", category: "spec", size: "S", status: "ready", priority: 2, agent: null, sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
    };
    const tracker = memoryTracker([task]);
    const runtime = mockRuntime(async (r) => {
      const out = r.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(r.cwd, out)), { recursive: true });
      await writeFile(join(r.cwd, out), "# PMX-31: Spec SSO\n\n## Problem\n\nAdmins share a password [T1].\n\n## Evidence\n\n- One shared password [T1]\n- An SSO ask [S1]\n\n## Validated by\n\nNot validated yet [T1].\n\n## Proposal\n\nSSO.\n\n## Success metrics\n\n- No shared passwords.\n\n## Open questions\n\nNone.\n");
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime });
    const svc = await services(ctx, { tracker });
    expect((await pull(ctx, svc, { dryRun: false })).ran?.outcome).toBe("ok");
    // A teammate's accept reached origin's main first.
    const mate = join(await tmp(), "mate");
    await git(dirname(mate), "clone", "-q", origin!, mate);
    await writeFile(join(mate, "theirs.md"), "a teammate's accept\n");
    await git(mate, "add", "-A");
    await git(mate, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "theirs");
    await git(mate, "push", "-q", "origin", "main");
    const { items, host } = await loadQueue(ctx, svc);
    expect(host.kind).toBe("local");
    const msg = await decide(ctx, svc, host, items[0]!, "accepted");
    expect(msg).toBe("PMX-31 accepted. The accepted draft is only on this Mac until you run git push in your team repo: your team's repo has newer work, so PMX didn't push over it.");
    expect(tracker.tasks.get("lin-31")!.status).toBe("done");

    const onlyGit: Exec = (cmd, args, o) => (cmd === "git" ? exec(cmd, args, o) : Promise.resolve({ code: 1, stdout: "", stderr: "" }));
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: onlyGit, engine: async () => [] });
    expect(checks.find((c) => c.id === "repo.host")).toMatchObject({ ok: true, detail: expect.stringMatching(/^team repo isn't on GitHub, so drafts wait as local branches .* \(fast-forward only, never forced\)$/) });
  });
});
