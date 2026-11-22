// COMPAT-7: one update. `pmx update`, which a person runs, also runs PMX Engine's own updater where Engine is on this
// Mac (`pmxe update` through the bridge, so Engine's own upgrade steps run), and says in one sentence how it went. A
// refusal (while a release is being sent) or a failure never undoes PMX's own update. The background job never runs it,
// and `pmx update --check` only reports. `pmxe` here is a stand-in script; nothing is installed.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateStep } from "../src/commands/autoupdate.js";
import { commands } from "../src/commands/index.js";
import { savePersonalConfig } from "../src/core/config.js";
import { exec, execOk, type Exec } from "../src/core/exec.js";
import { engineUpdateLine, updateEngineToo, type EngineUpdate } from "../src/core/update.js";
import { runEngineUpdate } from "../src/engine/bridge.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";

/** `pmxe`: its version, and `update` as the mode file says; every call is logged. */
async function fakePmxe(mode: "latest" | "busy" | "updated" | "broken") {
  const dir = await tmp("fake-pmxe-");
  await writeFile(join(dir, "mode"), mode);
  const cmd = join(dir, "pmxe");
  await writeFile(cmd, `#!/bin/sh
echo "$@" >> "${dir}/log"
case "$1" in
  --version) echo 0.12.0 ;;
  update) case "$(cat "${dir}/mode")" in
    latest) echo "pmx-engine 0.12.0 is the latest." ;;
    busy) printf 'Not updating while a release is being sent. A new version could disagree with what was approved.\\n- vision@company.e1: sales is approved, waiting to be sent.\\n' >&2; exit 1 ;;
    updated) echo "Updated pmx-engine from 0.12.0 to 0.13.0. npm checked the package's integrity hash."; echo "Brought PMX Engine's skills up to date." ;;
    broken) echo "npm could not install pmx-engine 0.13.0. Nothing in the workspace was changed." >&2; exit 2 ;;
  esac ;;
esac
`);
  await chmod(cmd, 0o755);
  return { cmd, log: async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter(Boolean), mode: (m: string) => writeFile(join(dir, "mode"), m) };
}

/** A set-up Mac whose team package is older than this pmx, so PMX's own update is "Up to date" and installs nothing. */
async function setUpMac() {
  const { repo } = await pmxRepo();
  const pkg = await tmp("pkg-");
  await mkdir(join(pkg, "package"), { recursive: true });
  await writeFile(join(pkg, "package", "package.json"), JSON.stringify({ name: "productmaxxing", version: "0.1.0" }));
  await mkdir(join(repo, ".pmx", "cli"), { recursive: true });
  await execOk("tar", ["-czf", join(repo, ".pmx", "cli", "productmaxxing.tgz"), "-C", pkg, "package"]);
  const ctx = await testCtx({ repo });
  await savePersonalConfig(ctx.personal);
  return ctx;
}

async function runUpdate(values: Record<string, unknown> = {}): Promise<{ code: number; out: string }> {
  const cmd = commands.find((c) => c.name === "update")!;
  const lines: string[] = [];
  const log = console.log, warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const code = await cmd.run({ values, positionals: [], ask: null as any, ctx: async () => { throw new Error("not used"); }, cliPath: "/x/cli.js" });
    return { code, out: lines.join("\n") };
  } finally { console.log = log; console.warn = warn; }
}

describe("one update (COMPAT-7)", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });

  it("runs Engine's update only from a command a person runs, and only where Engine is installed", async () => {
    let ran = 0;
    const run = async (): Promise<EngineUpdate | null> => { ran++; return { result: "current", version: "0.12.0" }; };
    expect(await updateEngineToo(run, { interactive: false })).toBeNull();
    expect(ran).toBe(0);
    expect(await updateEngineToo(run, { interactive: true })).toBe("PMX Engine 0.12.0 is the latest too.");
    expect(await updateEngineToo(async () => null, { interactive: true })).toBeNull();
    expect(await updateEngineToo(async () => { throw new Error("spawn pmxe ENOENT"); }, { interactive: true })).toBe("PMX Engine's update didn't finish (spawn pmxe ENOENT); PMX's own update is done, and pmxe update tries Engine's again.");
    // Without Engine, the bridge runs nothing at all.
    const calls: string[][] = [];
    const spy: Exec = async (c, a, o) => { calls.push([c, ...a]); return exec(c, a, o); };
    process.env.PMX_PMXE = "none";
    expect(await runEngineUpdate(spy)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads each way Engine's update ends, and runs it with no other arguments", async () => {
    const p = await fakePmxe("latest");
    process.env.PMX_PMXE = p.cmd;
    expect(await runEngineUpdate(exec)).toEqual({ result: "current", version: "0.12.0" });
    await p.mode("updated");
    expect(await runEngineUpdate(exec)).toEqual({ result: "updated", from: "0.12.0", to: "0.13.0" });
    await p.mode("busy");
    expect(await runEngineUpdate(exec)).toEqual({ result: "refused" });
    await p.mode("broken");
    expect(await runEngineUpdate(exec)).toEqual({ result: "failed", error: "npm could not install pmx-engine 0.13.0. Nothing in the workspace was changed." });
    expect((await p.log()).filter((l) => l !== "--version")).toEqual(["update", "update", "update", "update"]);
    expect(engineUpdateLine({ result: "updated", from: "0.12.0", to: "0.13.0" })).toBe("PMX Engine: updated from 0.12.0 to 0.13.0, and its own update steps ran (pmxe checklist shows anything left for you).");
    expect(engineUpdateLine({ result: "refused" })).toBe("PMX Engine wasn't updated: it doesn't update while a release is being sent, so finish sending it, then run pmx update again.");
  });

  it("pmx update updates Engine too; a refusal is one sentence, and PMX's own update still counts as done", async () => {
    await setUpMac();
    const p = await fakePmxe("busy");
    process.env.PMX_PMXE = p.cmd;
    const r = await runUpdate();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Up to date\./);
    expect(r.out).toContain("PMX Engine:    0.12.0 on this Mac, updated next");
    expect(r.out.trim().split("\n").at(-1)).toBe("PMX Engine wasn't updated: it doesn't update while a release is being sent, so finish sending it, then run pmx update again.");
    expect((await p.log()).filter((l) => l === "update")).toEqual(["update"]);

    await p.mode("updated");
    expect((await runUpdate()).out.trim().split("\n").at(-1)).toMatch(/^PMX Engine: updated from 0\.12\.0 to 0\.13\.0/);
  }, 30000);

  it("--check only reports Engine's version, and a Mac without Engine hears nothing about it", async () => {
    await setUpMac();
    const p = await fakePmxe("latest");
    process.env.PMX_PMXE = p.cmd;
    const check = await runUpdate({ check: true });
    expect(check.out).toContain("PMX Engine:    0.12.0 on this Mac");
    expect(check.out).not.toMatch(/updated next|is the latest too/);
    expect(await p.log()).not.toContain("update");

    process.env.PMX_PMXE = "none";
    const pm = await runUpdate();
    expect(pm.code).toBe(0);
    expect(pm.out).not.toMatch(/Engine/);
  }, 30000);

  it("the background job's update never runs Engine's", async () => {
    const p = await fakePmxe("latest");
    process.env.PMX_PMXE = p.cmd;
    const { repo } = await pmxRepo();
    const fake: Exec = async (cmd, args) => cmd === "tar" ? { code: 0, stdout: JSON.stringify({ version: "99.0.0" }), stderr: "" } : cmd === "npm" && args[0] === "prefix" ? { code: 0, stdout: "/usr/local\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    try {
      const ctx = { ...(await testCtx({ repo, team: { cli: { min: "0.5.0", autoUpdate: true } } })), exec: fake };
      expect(await updateStep(ctx)).toBe("auto-update: installed pmx 99.0.0");
    } finally { delete process.env.PMX_INSTALL_ROOT_FOR_TESTS; }
    expect(await p.log()).toEqual([]);
  });
});
