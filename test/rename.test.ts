import { fileURLToPath } from "node:url";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { exec as realExec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd, jobEnv, plist } from "../src/core/launchd.js";
import { LAUNCHD_LABEL } from "../src/core/paths.js";
import { asPackage, BRIDGE_CLI, migrateKeychain, migrateLaunchd, oldLaunchAgent, renameLeftovers, repackAs, swapPackage } from "../src/core/rename.js";
import { loadState } from "../src/core/state.js";
import { VENDORED_CLI, vendorCli } from "../src/core/vendor.js";
import { freshHome, tmp } from "./helpers.js";

const tgzJson = async (tgz: string) => JSON.parse((await realExec("tar", ["-xzOf", tgz, "package/package.json"])).stdout);

async function tinyPackage(name: string): Promise<string> {
  const dir = await tmp("pkg-");
  await mkdir(join(dir, "dist/src"), { recursive: true });
  await writeFile(join(dir, "dist/src/cli.js"), "#!/usr/bin/env node\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.15.0", bin: { pmx: "dist/src/cli.js", [name]: "dist/src/cli.js" }, files: ["dist"] }));
  return dir;
}

describe("0.15.0: ProductGit becomes ProductMaxxing without breaking a Mac (RENAME-1)", () => {
  beforeEach(freshHome);

  it("packs the same build under either name, with pmx and a command named after the package", async () => {
    expect(asPackage({ name: "productmaxxing", version: "1", bin: { pmx: "dist/src/cli.js", productmaxxing: "dist/src/cli.js" } }, "productgit"))
      .toEqual({ name: "productgit", version: "1", bin: { pmx: "dist/src/cli.js", productgit: "dist/src/cli.js" } });
    const dir = await tinyPackage("productmaxxing");
    const out = await tmp("out-");
    const packed = JSON.parse((await realExec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out, dir])).stdout)[0].filename;
    const bridge = await repackAs(join(out, packed), "productgit", out, realExec);
    expect(bridge).toMatch(/productgit-0\.15\.0\.tgz$/);
    expect(await tgzJson(bridge)).toMatchObject({ name: "productgit", version: "0.15.0", bin: { pmx: "dist/src/cli.js", productgit: "dist/src/cli.js" } });
  });

  it("the team's PMX repo gets the package and a bridge at the path older pmx reads", async () => {
    const repo = await tmp("repo-");
    await vendorCli(repo, realExec);
    expect((await tgzJson(join(repo, VENDORED_CLI))).name).toBe("productmaxxing");
    expect(await tgzJson(join(repo, BRIDGE_CLI))).toMatchObject({ name: "productgit", bin: { pmx: "dist/src/cli.js", productgit: "dist/src/cli.js" } });
  });

  it("moves keychain items to the new service and deletes the old copy only once the new one reads back", async () => {
    const from = memoryKeychain({ "slack-token": "xoxb-old", "github-token": "ghp-old" });
    const to = memoryKeychain({ "github-token": "ghp-already-new" });
    expect(await migrateKeychain(from, to)).toEqual(["slack-token", "github-token"]);
    expect(await from.list()).toEqual([]);
    expect(await to.get("slack-token")).toBe("xoxb-old");
    expect(await to.get("github-token")).toBe("ghp-already-new");
    const failing = { ...memoryKeychain(), async set() {}, async get() { return null; } };
    const keep = memoryKeychain({ "slack-token": "xoxb" });
    expect(await migrateKeychain(keep, failing)).toEqual([]);
    expect(await keep.get("slack-token")).toBe("xoxb");
  });

  it("swaps the bridge for productmaxxing: old package out, new one in, and the bridge back if that fails", async () => {
    const root = await tinyPackage("productgit");
    const scripts: string[] = [];
    const exec: Exec = async (cmd, args, o) => {
      if (cmd === "sh") { scripts.push(args[1]!); return { code: 0, stdout: "", stderr: "" }; }
      if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: "/opt/homebrew\n", stderr: "" };
      return realExec(cmd, args, o);
    };
    expect(await swapPackage(exec, root)).toEqual({ result: "swapped", bin: "/opt/homebrew/bin/pmx" });
    expect(scripts[0]).toMatch(/^npm uninstall -g productgit && npm install -g '[^']*productmaxxing-0\.15\.0\.tgz' \|\| \{ npm install -g '[^']*productgit-0\.15\.0\.tgz'; exit 1; \}$/);

    const denied: Exec = async (cmd, args, o) => (cmd === "sh" ? { code: 1, stdout: "", stderr: "npm error code EACCES" } : realExec(cmd, args, o));
    expect(await swapPackage(denied, root)).toMatchObject({ result: "needs-sudo", command: expect.stringMatching(/^sudo npm uninstall -g productgit && sudo npm install -g /) });
    expect(await swapPackage(exec, await tinyPackage("productmaxxing"))).toEqual({ result: "not-needed" });
    await mkdir(join(root, ".git"));
    expect(await swapPackage(exec, root)).toEqual({ result: "dev-install" });
  });

  it("re-registers the background job under its new name, keeps its Claude Code, and stops the old job last", async () => {
    await writeFile(oldLaunchAgent(), plist({ node: "/old/node", cli: "/opt/homebrew/lib/node_modules/productgit/dist/src/cli.js", pmxHome: "/h", claude: "/Users/x/.local/bin/claude" }).replace(LAUNCHD_LABEL, "com.productgit.pmx"));
    const launchd = fakeLaunchd();
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; };
    const cli = "/opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js";
    expect(await renameLeftovers(memoryKeychain({ "slack-token": "x" }))).toEqual(["the background job is still com.productgit.pmx", "1 keychain item(s) are still under \"productgit\""]);
    expect(await migrateLaunchd({ exec, launchd, cli, node: "/opt/homebrew/opt/node/bin/node" })).toBe(true);
    expect(launchd.plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(launchd.plist).toContain(`<string>${cli}</string>`);
    expect(jobEnv(launchd.plist!)).toMatchObject({ PMX_CLAUDE: "/Users/x/.local/bin/claude", node: "/opt/homebrew/opt/node/bin/node" });
    expect(await stat(oldLaunchAgent()).catch(() => null)).toBeNull();
    expect(calls.at(-1)).toEqual(["launchctl", "bootout", expect.stringMatching(/^gui\/\d+\/com\.productgit\.pmx$/)]);
    expect((await loadState()).renamed?.launchd).toBeTruthy();
    expect(await migrateLaunchd({ exec, launchd, cli, node: "n" })).toBe(false);
    expect(await renameLeftovers(memoryKeychain())).toEqual([]);
  });

  it("README and INSTALL tell an existing Mac how to move by hand", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const f of ["README.md", "INSTALL.md"]) expect(await readFile(join(root, f), "utf8")).toMatch(/npm uninstall -g productgit/);
  });
});
