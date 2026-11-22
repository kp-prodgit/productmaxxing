import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { updateStep } from "../src/commands/autoupdate.js";
import type { Exec } from "../src/core/exec.js";
import { loadState } from "../src/core/state.js";
import { installTeamVersion } from "../src/core/update.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";

/** Fakes tar (the vendored package's version) and npm; records every call. */
function fakeExec(o: { vendored: string | null; npm?: { code: number; stderr?: string }; globalPrefix?: string }) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "tar") return o.vendored ? { code: 0, stdout: JSON.stringify({ version: o.vendored }), stderr: "" } : { code: 1, stdout: "", stderr: "no file" };
    if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: `${o.globalPrefix ?? "/usr/local"}\n`, stderr: "" };
    if (cmd === "npm") return { code: o.npm?.code ?? 0, stdout: "", stderr: o.npm?.stderr ?? "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, npmCalls: () => calls.filter((c) => c[0] === "npm" && c[1] === "install") };
}

describe("installing the team's version (COMPAT-2, COMPAT-6)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
  });

  it("installs only a newer package, never downgrades, and never replaces a source checkout", async () => {
    const newer = fakeExec({ vendored: "0.37.0" });
    expect(await installTeamVersion("/repo", newer.exec)).toEqual({ result: "updated", version: "0.37.0" });
    expect(newer.npmCalls()[0]).toEqual(["npm", "install", "-g", "/repo/.pmx/cli/productmaxxing.tgz"]);

    const older = fakeExec({ vendored: "0.4.0" });
    expect(await installTeamVersion("/repo", older.exec)).toEqual({ result: "current", version: "0.4.0" });
    expect(older.npmCalls()).toEqual([]);

    expect((await installTeamVersion("/repo", fakeExec({ vendored: null }).exec)).result).toBe("no-package");

    delete process.env.PMX_INSTALL_ROOT_FOR_TESTS; // this test runs from a git checkout
    const dev = fakeExec({ vendored: "0.37.0" });
    expect(await installTeamVersion("/repo", dev.exec)).toEqual({ result: "dev-install", version: "0.37.0" });
    expect(dev.npmCalls()).toEqual([]);
  });

  it("explains a global folder that needs sudo", async () => {
    const r = await installTeamVersion("/repo", fakeExec({ vendored: "0.37.0", npm: { code: 243, stderr: "npm ERR! code EACCES" } }).exec);
    expect(r).toEqual({ result: "needs-sudo", version: "0.37.0", command: 'sudo npm install -g "/repo/.pmx/cli/productmaxxing.tgz"' });
  });

  it("updates into the folder pmx was installed under, not npm's own (--prefix)", async () => {
    // As `npm install -g --prefix /opt/homebrew` leaves it, while npm's own global folder is /usr/local.
    const prefix = await realpath(await tmp("homebrew-"));
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = join(prefix, "lib", "node_modules", "productmaxxing");
    await mkdir(process.env.PMX_INSTALL_ROOT_FOR_TESTS, { recursive: true });
    const elsewhere = fakeExec({ vendored: "0.37.0", globalPrefix: "/usr/local" });
    expect(await installTeamVersion("/repo", elsewhere.exec)).toEqual({ result: "updated", version: "0.37.0" });
    expect(elsewhere.npmCalls()[0]).toEqual(["npm", "install", "-g", "--prefix", prefix, "/repo/.pmx/cli/productmaxxing.tgz"]);

    // Installed in npm's own folder: the command stays as it always was.
    const same = fakeExec({ vendored: "0.37.0", globalPrefix: prefix });
    await installTeamVersion("/repo", same.exec);
    expect(same.npmCalls()[0]).toEqual(["npm", "install", "-g", "/repo/.pmx/cli/productmaxxing.tgz"]);

    // And the sudo hint names the same folder.
    const denied = fakeExec({ vendored: "0.37.0", globalPrefix: "/usr/local", npm: { code: 243, stderr: "EACCES" } });
    expect(await installTeamVersion("/repo", denied.exec)).toMatchObject({ result: "needs-sudo", command: `sudo npm install -g --prefix "${prefix}" "/repo/.pmx/cli/productmaxxing.tgz"` });
  });
});

describe("background auto-update (COMPAT-6)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
  });

  async function ctxWith(fx: ReturnType<typeof fakeExec>, autoUpdate: boolean | undefined, now = new Date("2026-11-06T10:00:00Z")) {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now, team: { cli: { min: "0.5.0", ...(autoUpdate === undefined ? {} : { autoUpdate }) } } });
    return { ...ctx, exec: fx.exec };
  }

  it("does nothing unless the team turned it on", async () => {
    const fx = fakeExec({ vendored: "0.37.0" });
    expect(await updateStep(await ctxWith(fx, undefined))).toBeNull();
    expect(await updateStep(await ctxWith(fx, false))).toBeNull();
    expect(fx.calls).toEqual([]);
  });

  it("installs a newer team version, then waits an hour before looking again", async () => {
    const fx = fakeExec({ vendored: "0.37.0" });
    const ctx = await ctxWith(fx, true);
    expect(await updateStep(ctx)).toBe("auto-update: installed pmx 0.37.0");
    expect((await loadState()).autoUpdate).toMatchObject({ result: "updated", version: "0.37.0" });
    expect(await updateStep(ctx)).toBeNull();
    expect(fx.npmCalls()).toHaveLength(1);
    const later = { ...ctx, now: () => new Date("2026-11-06T11:30:00Z") };
    await updateStep(later);
    expect(fx.npmCalls()).toHaveLength(2);
  });

  it("says once per version when it needs sudo, and keeps the result for doctor", async () => {
    const fx = fakeExec({ vendored: "0.37.0", npm: { code: 243, stderr: "EACCES: permission denied" } });
    const ctx = await ctxWith(fx, true);
    expect(await updateStep(ctx)).toMatch(/pmx 0\.37\.0 is waiting \(Run: sudo npm install -g/);
    const later = { ...ctx, now: () => new Date("2026-11-06T12:00:00Z") };
    expect(await updateStep(later)).toBeNull(); // same version: no second notice
    expect((await loadState()).autoUpdate).toMatchObject({ result: "needs-sudo", version: "0.37.0", notifiedFor: "0.37.0" });
  });
});
