import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { resolveEnv } from "../src/core/skillcheck.js";
import { orgSkillPath, teamSkillPath } from "../src/core/skills.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { runTask } from "../src/run/run.js";
import {
  checkRun,
  envTrustProblem,
  isSupportedEnv,
  prototypeDir,
  resolveTemplate,
  runInstructions,
  scaffold,
  scaffoldProblem,
  stagePaths,
} from "../src/run/environments.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const skillText = (name: string, pmx: Record<string, unknown>) =>
  `---\nname: ${name}\ndescription: ${name} builds a thing for tests, long enough to pass.\npmx: ${JSON.stringify(pmx)}\n---\n# ${name}\n\n## Summary\n\nx\n`;

async function writeSkillFile(repo: string, name: string, pmx: Record<string, unknown>): Promise<void> {
  const p = teamSkillPath(repo, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, skillText(name, pmx));
}

const repoEnv = () =>
  resolveEnv({ kind: "category", env: { kind: "prototype", tools: ["Read", "Bash"], template: "tpl", output: { kind: "repo" } } }, "proto");
const urlEnv = () =>
  resolveEnv({ kind: "category", env: { kind: "prototype", tools: ["Read", "Bash", "WebFetch"], runtime: "v0", output: { kind: "url" } } }, "proto");
const docEnv = () => resolveEnv({ kind: "category", category: "spec" }, "spec");

describe("prototype environment helpers (JOB-1, Slice 3)", () => {
  it("only document and prototype run today; brief stays reserved", () => {
    expect(isSupportedEnv("document")).toBe(true);
    expect(isSupportedEnv("prototype")).toBe(true);
    expect(isSupportedEnv("brief")).toBe(false);
  });

  it("a widened (non-document) env may only run from a team skill (tiered trust)", () => {
    expect(envTrustProblem(docEnv(), "org")).toBeNull();
    expect(envTrustProblem(repoEnv(), "team")).toBeNull();
    expect(envTrustProblem(repoEnv(), "org")).toMatch(/may only run from a team skill/);
    expect(envTrustProblem(repoEnv(), "bundled")).toMatch(/may only run from a team skill/);
  });

  it("resolveEnv gives kind-aware default output paths without changing the document default", () => {
    expect(docEnv().output.path).toBe("outputs/spec/{id}.md");
    expect(repoEnv().output.path).toBe("prototypes/proto/{id}");
    expect(urlEnv().output.path).toBe("prototypes/proto/{id}/PREVIEW.url");
    expect(prototypeDir(repoEnv(), "prototypes/proto/PRO-1")).toBe("prototypes/proto/PRO-1");
    expect(prototypeDir(urlEnv(), "prototypes/proto/PRO-1/PREVIEW.url")).toBe("prototypes/proto/PRO-1");
  });

  it("resolveTemplate keeps templates strictly inside the repo", () => {
    expect(resolveTemplate("/repo", ".pmx/templates/next")).toBe("/repo/.pmx/templates/next");
    expect(() => resolveTemplate("/repo", "/etc/passwd")).toThrow(/absolute/);
    expect(() => resolveTemplate("/repo", "../outside")).toThrow(/escapes the repo/);
  });

  it("instructions widen the prototype wording and keep the document contract intact", () => {
    const proto = runInstructions(repoEnv(), "prototypes/proto/PRO-1", "PRO-1");
    expect(proto).toContain("prototypes/proto/PRO-1/");
    expect(proto).toMatch(/Don't commit/);
    const url = runInstructions(urlEnv(), "prototypes/proto/PRO-1/PREVIEW.url", "PRO-1");
    expect(url).toContain("live preview URL");
    expect(url).toContain('"v0"');
    // The document runner's mock parses this exact phrase; it must not drift.
    expect(runInstructions(docEnv(), "outputs/spec/PRO-1.md", "PRO-1")).toContain("Write the output to outputs/spec/PRO-1.md");
  });

  it("stages everything for a prototype but only outputs/ for a document", () => {
    expect(stagePaths(repoEnv())).toEqual(["-A"]);
    expect(stagePaths(docEnv())).toEqual(["--", "outputs", ".pmx/runs"]);
  });

  it("scaffold copies a template into the prototype dir and fails closed when it's missing", async () => {
    const wt = await tmp("wt-");
    await mkdir(join(wt, "tpl", "src"), { recursive: true });
    await writeFile(join(wt, "tpl", "package.json"), "{}");
    await writeFile(join(wt, "tpl", "src", "index.ts"), "x");
    const copied = await scaffold(wt, repoEnv(), "prototypes/proto/PRO-1");
    expect(copied.sort()).toEqual(["package.json", "src"]);
    await expect(scaffold(wt, repoEnv(), "prototypes/proto/PRO-1")).resolves.toBeTruthy();
    const bad = resolveEnv({ kind: "category", env: { kind: "prototype", template: "nope", output: { kind: "repo" } } }, "proto");
    expect(await scaffoldProblem(wt, bad, "prototypes/proto/X")).toMatch(/not found/);
    expect(await scaffoldProblem(wt, docEnv(), "outputs/spec/A.md")).toBeNull();
  });

  it("the it-ran check needs files for a repo job and a URL for a url job", async () => {
    const wt = await tmp("wt-");
    // repo: empty fails, non-empty passes
    const empty = await checkRun(repoEnv(), { kind: "category" }, wt, "prototypes/proto/PRO-1", new Set());
    expect(empty.ok).toBe(false);
    expect(empty.problems[0]).toMatch(/no prototype files/);
    await mkdir(join(wt, "prototypes", "proto", "PRO-1"), { recursive: true });
    await writeFile(join(wt, "prototypes", "proto", "PRO-1", "index.html"), "<h1>hi</h1>");
    const ok = await checkRun(repoEnv(), { kind: "category" }, wt, "prototypes/proto/PRO-1", new Set());
    expect(ok).toMatchObject({ ok: true, ref: "prototypes/proto/PRO-1" });
    // url: a written http(s) URL passes and becomes the ref
    await mkdir(join(wt, "prototypes", "proto", "PRO-2"), { recursive: true });
    await writeFile(join(wt, "prototypes", "proto", "PRO-2", "PREVIEW.url"), "https://pro-2.vercel.app\n");
    const url = await checkRun(urlEnv(), { kind: "category" }, wt, "prototypes/proto/PRO-2/PREVIEW.url", new Set());
    expect(url).toMatchObject({ ok: true, ref: "https://pro-2.vercel.app" });
    const missing = await checkRun(urlEnv(), { kind: "category" }, wt, "prototypes/proto/NONE/PREVIEW.url", new Set());
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toMatch(/no preview URL/);
  });
});

const protoTask = (over: Partial<Task> = {}): Task => ({
  id: "lin-9",
  identifier: "PRO-1",
  title: "Prototype the SCIM settings screen",
  description: "Build a screen to configure SCIM.\n\npmx:source T1",
  url: "https://linear.app/acme/issue/PRO-1",
  category: "proto",
  size: "M",
  status: "ready",
  priority: 2,
  agent: null,
  sources: ["T1"],
  prUrl: null,
  createdAt: "2026-11-01T00:00:00Z",
  ...over,
});

/** A runtime that behaves like a prototype build: writes files under the prototype directory. */
const prototyping = () =>
  mockRuntime(async (o) => {
    const dir = o.prompt.match(/prototype under (\S+)\//)?.[1];
    if (dir) {
      await mkdir(join(o.cwd, dir), { recursive: true });
      await writeFile(join(o.cwd, dir, "index.html"), "<h1>SCIM settings</h1>");
      await writeFile(join(o.cwd, dir, "app.js"), "console.log('runs')");
    }
    return { text: "Scaffolded a working SCIM settings prototype." };
  });

async function leaseAndRun(ctx: Awaited<ReturnType<typeof testCtx>>, tracker: ReturnType<typeof memoryTracker>, task: Task) {
  const svc = await services(ctx, { tracker });
  const got = await svc.lease.acquire(task.id, ctx.agent, 600);
  expect(got.ok).toBe(true);
  if (!got.ok) throw new Error("lease");
  return runTask(ctx, svc, { ...task, agent: ctx.agent, status: "claimed" }, got.lease);
}

describe("running a prototype job end to end (JOB-1, Slice 3)", () => {
  beforeEach(freshHome);
  const protoTeam = { categories: { ...DEFAULT_TEAM.categories, proto: { skill: "proto" } } };

  it("scaffolds from a template, runs with widened tools, and opens a PR whose record is a repo artifact", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    await writeSkillFile(repo, "proto", {
      kind: "category",
      category: "proto",
      env: { kind: "prototype", template: ".pmx/templates/next-min", tools: ["Read", "Write", "Edit", "Bash"], runtime: "v0", output: { kind: "repo" } },
    });
    await mkdir(join(repo, ".pmx/templates/next-min"), { recursive: true });
    await writeFile(join(repo, ".pmx/templates/next-min/package.json"), '{"name":"proto-starter"}');
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "add proto job + template");
    await git(repo, "push", "-q", "origin", "main");

    const runtime = prototyping();
    const tracker = memoryTracker([protoTask()]);
    const ctx = await testCtx({ repo, runtime, team: protoTeam, now: new Date(2026, 10, 4, 10) });
    const r = await leaseAndRun(ctx, tracker, protoTask());

    expect(r.outcome).toBe("ok");
    expect(r.prUrl).toMatch(/^branch:pmx\/task\/PRO-1/);
    // The agent got the widened tool set, not the sealed document set.
    expect(runtime.calls[0]!.tools).toContain("Bash");
    expect(tracker.tasks.get("lin-9")!.status).toBe("review");

    const branch = "pmx/task/PRO-1-prototype-the-scim-settings-screen";
    const files = (await git(repo, "show", "--name-only", "--format=", branch)).split("\n").filter(Boolean).sort();
    expect(files).toContain("prototypes/proto/PRO-1/index.html"); // the build's output
    expect(files).toContain("prototypes/proto/PRO-1/package.json"); // scaffolded from the template
    expect(files).toContain(".pmx/runs/PRO-1.json");

    const record = JSON.parse(await git(repo, "show", `${branch}:.pmx/runs/PRO-1.json`));
    expect(record).toMatchObject({ outcome: "ok", artifact: { kind: "repo", ref: "prototypes/proto/PRO-1" }, checklist: { ok: true } });
    expect(record.skill.source).toBe("team");
  });

  it("fails closed when a prototype's template is missing: back to ready, no PR", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    await writeSkillFile(repo, "proto", {
      kind: "category",
      category: "proto",
      env: { kind: "prototype", template: ".pmx/templates/gone", tools: ["Read", "Bash"], output: { kind: "repo" } },
    });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "proto job with a missing template");
    await git(repo, "push", "-q", "origin", "main");

    const tracker = memoryTracker([protoTask()]);
    const ctx = await testCtx({ repo, runtime: prototyping(), team: protoTeam, now: new Date(2026, 10, 4, 10) });
    const r = await leaseAndRun(ctx, tracker, protoTask());

    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/template not found/);
    expect(tracker.tasks.get("lin-9")).toMatchObject({ status: "ready", agent: null });
    expect(await git(repo, "branch", "--list", "pmx/task/*")).toBe("");
  });

  it("refuses a prototype that arrives as an org (Linear-synced) skill — widening needs a reviewed repo skill", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    // No team skill file: the only "op" skill lives in the org cache, as if synced from Linear.
    const orgSkill = orgSkillPath("org-proto");
    await mkdir(dirname(orgSkill), { recursive: true });
    await writeFile(orgSkill, skillText("org-proto", { kind: "category", category: "op", env: { kind: "prototype", tools: ["Read", "Bash"], output: { kind: "repo" } } }));

    const task = protoTask({ id: "lin-x", identifier: "PRO-7", title: "Org prototype", category: "op" });
    const tracker = memoryTracker([task]);
    const ctx = await testCtx({ repo, team: { categories: { ...DEFAULT_TEAM.categories, op: { skill: "org-proto" } } }, now: new Date(2026, 10, 4, 10) });
    const r = await leaseAndRun(ctx, tracker, task);

    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/may only run from a team skill/);
    expect(tracker.tasks.get("lin-x")).toMatchObject({ status: "ready", agent: null });
    expect(await git(repo, "branch", "--list", "pmx/task/*")).toBe("");
  });
});
