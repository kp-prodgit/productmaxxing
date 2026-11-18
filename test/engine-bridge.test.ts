// Phase 2 of joining PMX and PMX Engine (Q16): one doctor, one What's new, and a way into the studio from this Mac's
// page. PMX reads only `pmxe`'s versioned JSON, never Engine's files, and nothing about Engine reaches a Claude chat.
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { exec, type Exec } from "../src/core/exec.js";
import { engineChecks, engineNotes, findPmxe, formatEngineNotes, openStudio } from "../src/engine/bridge.js";
import { startExplainServer } from "../src/explain/server.js";
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
  studio) echo studio >> "${log}" ;;
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

  it("opens the studio from this Mac's page only, behind the page's token", async () => {
    const fake = await fakePmxe({ doctor: DOCTOR, notes: NOTES });
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    let opened = 0;
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, studio: { status: async () => ({ available: true, version: "0.3.4" }), open: async () => { opened++; openStudio({ cmd: fake.cmd, version: "0.3.4" }); } } });
    const bare = await startExplainServer({ team: ctx.team, personal: ctx.personal });
    try {
      const call = (srv: typeof s, path: string, body?: unknown, token = new URL(srv.url).hash.slice(3)) =>
        fetch(`http://127.0.0.1:${srv.port}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      expect(await (await call(s, "/api/studio")).json()).toEqual({ available: true, version: "0.3.4" });
      expect((await call(s, "/api/studio/open", {}, "wrong")).status).toBe(403);
      expect((await call(s, "/api/studio/open", {})).status).toBe(200);
      expect(opened).toBe(1);
      for (let i = 0; i < 50 && !(await readFile(fake.log, "utf8").catch(() => "")); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await readFile(fake.log, "utf8")).toBe("studio\n");
      // A server started without the studio, as `pmx explain --web` is, knows nothing about it.
      expect(await (await call(bare, "/api/studio")).json()).toEqual({ available: false });
      expect((await call(bare, "/api/studio/open", {})).status).not.toBe(200);
    } finally {
      await s.close();
      await bare.close();
    }
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

    // This Mac's page shows the Studio entry only after this Mac's server says so; the page in Claude never asks.
    const page = await readFile(join(root, "app-skills", "pmx-flow", "pipeline.html"), "utf8");
    expect(page).toContain('<button type="button" class="ni" id="act-studio" hidden>');
    expect(page).toContain('if (LOCAL) api("/api/studio")');
  });
});
