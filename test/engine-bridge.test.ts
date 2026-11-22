// Phase 2 of joining PMX and PMX Engine (Q16): one doctor, one What's new, and a way into the studio from PMX's page.
// PMX reads only `pmxe`'s versioned JSON, never Engine's files, and nothing about Engine reaches a Claude chat. The
// Strategy area (BOARD-11) is tested in test/strategy.test.ts.
import { chmod, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { exec, type Exec } from "../src/core/exec.js";
import { engineChecklist, engineChecks, engineNotes, findPmxe, formatEngineNotes, locatePmxe, openStudio } from "../src/engine/bridge.js";
import { startExplainServer } from "../src/explain/server.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { MCP_TOOLS } from "../src/mcp/server.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** A stand-in for `pmxe`: its version, and doctor and whats-new answers from files; `studio` is logged. */
async function fakePmxe(o: { doctor: unknown; notes: unknown }): Promise<{ cmd: string; log: string }> {
  const dir = await tmp("fake-pmxe-");
  await writeFile(join(dir, "doctor.json"), JSON.stringify(o.doctor));
  await writeFile(join(dir, "notes.json"), JSON.stringify(o.notes));
  const log = join(dir, "studio.log");
  const cmd = join(dir, "pmxe");
  await writeFile(cmd, `#!/bin/sh
case "$1" in
  --version) echo 0.3.4 ;;
  doctor) cat "${dir}/doctor.json" ;;
  whats-new) cat "${dir}/notes.json" ;;
  studio) echo "$@" >> "${log}" ;;
esac
`);
  await chmod(cmd, 0o755);
  return { cmd, log };
}

const DOCTOR = {
  format: 1, ok: false, version: "0.3.4", workspace: join(process.env.HOME ?? "/Users/x", "pmxe-workspace"),
  checks: [{ level: "ok", text: "pmx-engine 0.3.4" }, { level: "warn", text: "3 of 13 hubs are set up (run /pmxe-hubs in Claude)" }, { level: "fail", text: "The mirror folder is missing" }],
};
const NOTES = { format: 1, ok: true, version: "0.3.4", since: "0.3.3", notes: [{ version: "0.3.4", title: "What PMX reads from Engine", body: "…" }] };

describe("phase 2: PMX reads PMX Engine through one bridge", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });

  it("changes nothing on a Mac without PMX Engine, as on every PM's", async () => {
    process.env.PMX_PMXE = "none";
    expect(await findPmxe(exec)).toBeNull();
    expect(await engineChecks(exec)).toEqual([]);
    expect(await engineNotes(exec)).toBeNull();
    expect(formatEngineNotes(null)).toBe("");
    // A version line that isn't exactly a version (Claude Code's, say) is not Engine.
    const claudeLike: Exec = async () => ({ code: 0, stdout: "2.1.0 (Claude Code)\n", stderr: "" });
    delete process.env.PMX_PMXE;
    expect(await findPmxe(claudeLike)).toBeNull();
    process.env.PMX_PMXE = "none";

    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec });
    expect(checks.filter((c) => c.id.startsWith("engine"))).toEqual([]);
  });

  it("shows Engine's problems in pmx doctor as warnings, so they never fail it", async () => {
    process.env.PMX_PMXE = (await fakePmxe({ doctor: DOCTOR, notes: NOTES })).cmd;
    const rows = await engineChecks(exec);
    expect(rows[0]).toMatchObject({ id: "engine", ok: true, detail: "PMX Engine 0.3.4, workspace folder ~/pmxe-workspace: 2 to look at (pmxe doctor)" });
    expect(rows.slice(1).map((r) => r.detail)).toEqual(["PMX Engine: 3 of 13 hubs are set up (run /pmxe-hubs in Claude)", "PMX Engine: The mirror folder is missing"]);
    expect(rows.every((r) => r.level === "warn")).toBe(true);

    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec, engine: async () => rows });
    expect(checks.slice(-3).map((c) => c.id)).toEqual(["engine", "engine.1", "engine.2"]);
    expect(checks.filter((c) => c.id.startsWith("engine") && c.level === "fail")).toEqual([]);
  });

  it("reads only a format it knows, and otherwise says to run pmxe doctor", async () => {
    process.env.PMX_PMXE = (await fakePmxe({ doctor: { ...DOCTOR, format: 2 }, notes: { ...NOTES, format: 2 } })).cmd;
    expect(await engineChecks(exec)).toEqual([{ id: "engine", ok: false, level: "warn", detail: "PMX Engine 0.3.4 is installed, but this pmx can't read its checks. Run pmxe doctor." }]);
    expect(await engineNotes(exec)).toBeNull();
    process.env.PMX_PMXE = (await fakePmxe({ doctor: "not json", notes: [] })).cmd;
    expect((await engineChecks(exec))[0]!.ok).toBe(false);
  });

  it("adds Engine's unseen notes after PMX's in pmx whats-new", async () => {
    process.env.PMX_PMXE = (await fakePmxe({ doctor: DOCTOR, notes: NOTES })).cmd;
    const e = await engineNotes(exec);
    expect(e).toEqual({ version: "0.3.4", since: "0.3.3", notes: [{ version: "0.3.4", title: "What PMX reads from Engine" }] });
    expect(formatEngineNotes(e)).toBe("PMX Engine 0.3.4\n  0.3.4: What PMX reads from Engine\n  The details: pmxe whats-new --since 0.3.3");
    expect(formatEngineNotes({ ...e!, notes: [] })).toBe("");
  });

  it("opens the studio at a place from this Mac's page, behind the page's token (BOARD-11)", async () => {
    const fake = await fakePmxe({ doctor: DOCTOR, notes: NOTES });
    process.env.PMX_PMXE = fake.cmd;
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const { engineSource } = await import("../src/engine/bridge.js");
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: pipelineHandlers(ctx, { engine: engineSource(exec) }) });
    const bare = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: pipelineHandlers(ctx) });
    try {
      const call = (srv: typeof s, path: string, body?: unknown, token = new URL(srv.url).hash.slice(3)) =>
        fetch(`http://127.0.0.1:${srv.port}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      expect((await call(s, "/api/pipeline/engine-open", { place: "release" }, "wrong")).status).toBe(403);
      expect((await call(s, "/api/pipeline/engine-open", { place: "../../etc" })).status).toBe(400);
      expect((await call(s, "/api/pipeline/engine-open", { place: "release/ready" })).status).toBe(200);
      for (let i = 0; i < 50 && !(await readFile(fake.log, "utf8").catch(() => "")); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await readFile(fake.log, "utf8")).toBe("studio --at release/ready\n");
      // The old endpoints are gone: the page opens the studio through its own actions now.
      expect((await call(s, "/api/studio")).status).toBe(404);
      // A server started without Engine, as on every PM's Mac, knows nothing about it.
      expect((await call(bare, "/api/pipeline/engine-open", { place: "release" })).status).toBe(404);
      // `pmx open studio` still opens it as it is.
      openStudio({ cmd: fake.cmd, version: "0.3.4" });
      for (let i = 0; i < 50 && !/\nstudio\n/.test(await readFile(fake.log, "utf8")); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await readFile(fake.log, "utf8")).toBe("studio --at release/ready\nstudio\n");
      expect(openStudio({ cmd: fake.cmd, version: "0.3.4" }, "nowhere" as any)).toBe(false);
    } finally {
      await s.close();
      await bare.close();
    }
  });

  it("runs an Engine installed as a link to its JavaScript with PMX's own Node, whatever its #! line says (CLI-6)", async () => {
    // npm links the command to Engine's cli.js, whose `#!/usr/bin/env node` fails where node isn't on PATH (launchd).
    const dir = await tmp("fake-pmxe-js-");
    const cli = join(dir, "lib", "cli.js");
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(cli, `#!/nowhere/node\nconst a = process.argv.slice(2);\nif (a[0] === "--version") console.log("0.4.1");\nelse if (a[0] === "doctor") console.log(JSON.stringify(${JSON.stringify(DOCTOR)}));\n`);
    await chmod(cli, 0o755);
    await mkdir(join(dir, "bin"), { recursive: true });
    await symlink(cli, join(dir, "bin", "pmxe"));
    // The shebang alone can't start it.
    expect((await exec(join(dir, "bin", "pmxe"), ["--version"])).code).not.toBe(0);

    process.env.PMX_PMXE = join(dir, "bin", "pmxe");
    const p = await findPmxe(exec);
    expect(p).toEqual({ cmd: process.execPath, args: [await realpath(cli)], version: "0.4.1", path: join(dir, "bin", "pmxe") });
    // Later calls run the same way: doctor answers through the same Node and entry point.
    expect((await engineChecks(exec))[0]).toMatchObject({ ok: true, detail: expect.stringMatching(/^PMX Engine 0\.4\.1, workspace folder ~\/pmxe-workspace/) });

    // Unpinned: found in the usual install folders, never through PATH's own lookup, with a long enough wait.
    delete process.env.PMX_PMXE;
    const path = process.env.PATH;
    const calls: [string, string[], number | undefined][] = [];
    const spy: Exec = async (cmd, args, o) => { calls.push([cmd, args, o?.timeoutMs]); return exec(cmd, args, o); };
    try {
      process.env.PATH = await tmp("empty-path-");
      expect(await findPmxe(spy, { candidates: [join(dir, "missing", "pmxe"), join(dir, "bin", "pmxe")] })).toMatchObject({ cmd: process.execPath, version: "0.4.1" });
    } finally { process.env.PATH = path; process.env.PMX_PMXE = "none"; }
    expect(calls).toEqual([[process.execPath, [await realpath(cli), "--version"], 20000]]);

    // Found but not answering is a problem with where it is and why, not "not installed".
    const broken: Exec = async () => ({ code: 1, stdout: "", stderr: "Error: Cannot find module 'commander'\nRequire stack: …" });
    try {
      delete process.env.PMX_PMXE;
      process.env.PATH = await tmp("empty-path-");
      expect(await locatePmxe(broken, { candidates: [join(dir, "bin", "pmxe")] })).toEqual({ problem: { path: join(dir, "bin", "pmxe"), reason: "Cannot find module 'commander'" } });
    } finally { process.env.PATH = path; process.env.PMX_PMXE = "none"; }
  });

  it("says Engine is installed but didn't start, instead of that it isn't on this Mac (CLI-6)", async () => {
    const dir = await tmp("broken-pmxe-");
    const cmd = join(dir, "pmxe");
    await writeFile(cmd, "#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n");
    await chmod(cmd, 0o755);
    process.env.PMX_PMXE = cmd;
    expect(await findPmxe(exec)).toBeNull();
    expect(await locatePmxe(exec)).toEqual({ problem: { path: cmd, reason: "env: node: No such file or directory" } });
    expect(await engineChecks(exec)).toEqual([{ id: "engine", ok: false, level: "warn", detail: `PMX Engine is installed at ${cmd} but didn't start: env: node: No such file or directory. In Terminal, pmxe --version shows why.` }]);
    const summary = await engineChecklist(exec);
    expect(summary).toEqual({ problem: { path: cmd, reason: "env: node: No such file or directory" } });
    const { buildChecklist } = await import("../src/setup/checklist.js");
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const cl = buildChecklist({ now: new Date(), version: "0.35.0", personal: ctx.personal, team: ctx.team, checks: [], state: { collectReports: [] } as any, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: summary, extra: [] });
    const step = cl.sections.flatMap((s) => s.steps).find((s) => s.id === "engine.installed")!;
    expect(step).toMatchObject({ status: "warn", detail: `PMX Engine is installed at ${cmd} but didn't start: env: node: No such file or directory`, who: "you", how: "terminal" });
    expect(step.detail).not.toMatch(/isn't on this Mac/);
  });

  it("keeps Engine out of everything that answers a Claude chat, and never reads Engine's files", async () => {
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /studio|engine/i.test(n))).toEqual([]);
    const src = join(root, "src");
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    await walk(src);
    const importers: string[] = [];
    for (const f of files) if (/from "(\.\.\/|\.\/)engine\/bridge\.js"/.test(await readFile(f, "utf8"))) importers.push(f.slice(src.length + 1));
    expect(importers.sort()).toEqual(["commands/doctor.ts", "commands/flow.ts", "commands/index.ts"]);
    const bridge = await readFile(join(src, "engine", "bridge.ts"), "utf8");
    expect(bridge).not.toMatch(/node:fs|\.pmx-engine|readFile/);

    // The page shows the Strategy slot only when its data carries Engine, which only this Mac's own page and the paired
    // page's board do (test/strategy.test.ts proves the rest).
    const page = await readFile(join(root, "app-skills", "pmx-flow", "pipeline.html"), "utf8");
    expect(page).toContain('<button type="button" class="ni" data-view="strategy" id="nav-strategy" hidden>');
    expect(page).toContain('$("nav-strategy").hidden = !(ok && engine());');
    expect(page).not.toContain("/api/studio");
  });
});
