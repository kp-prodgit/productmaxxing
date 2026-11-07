import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { macKeychain, type Keychain, type SecretName } from "./keychain.js";
import { jobEnv, plist, stableNode, type Launchd } from "./launchd.js";
import { LAUNCHD_LABEL, pmxHome } from "./paths.js";
import { packageRoot } from "./skills.js";
import { loadState, updateState } from "./state.js";
import { isDevInstall } from "./update.js";

/**
 * The ProductGit → ProductMaxxing rename (0.15.0, RENAME-1). Before it, the npm package was `productgit`, keychain items
 * lived under the service `productgit` and the background job was `com.productgit.pmx`. npm refuses to install a
 * differently named package over the old one's `pmx` command, so a 0.14.0 Mac can't update to `productmaxxing` directly.
 *
 * So every release and the team's PMX repo also carry a bridge: the same code packed as `productgit`, at the old file
 * names. A 0.14.0 Mac updates to it in place. On its first run the bridge moves the keychain items, swaps itself for
 * the `productmaxxing` package and hands over to it, and that one re-registers the background job under its new name.
 */
export const OLD = { pkg: "productgit", keychain: "productgit", label: "com.productgit.pmx" } as const;
export const NEW_PKG = "productmaxxing";
/** Where 0.14.0 and older look for the team's package. `pmx vendor` keeps a bridge there. */
export const BRIDGE_CLI = ".pmx/cli/productgit.tgz";
export const oldLaunchAgent = () => process.env.PMX_OLD_LAUNCH_AGENT_FOR_TESTS ?? join(homedir(), "Library", "LaunchAgents", `${OLD.label}.plist`);

/** package.json under another name: the same code, with the `pmx` command and one named after the package. */
export function asPackage(pkg: Record<string, any>, name: string): Record<string, any> {
  const cli = (pkg.bin && pkg.bin.pmx) || "dist/src/cli.js";
  return { ...pkg, name, bin: { pmx: cli, [name]: cli } };
}

/** Repacks a package tarball under another name into `outDir`, and returns the new tarball's path. */
export async function repackAs(tgz: string, name: string, outDir: string, exec: Exec): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "pmx-repack-"));
  try {
    const x = await exec("tar", ["-xzf", tgz, "-C", work]);
    if (x.code !== 0) throw new Error(`couldn't unpack ${tgz}: ${x.stderr.trim()}`);
    const file = join(work, "package", "package.json");
    await writeFile(file, `${JSON.stringify(asPackage(JSON.parse(await readFile(file, "utf8")), name), null, 2)}\n`);
    const r = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outDir, join(work, "package")], { timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`npm pack failed: ${r.stderr.trim()}`);
    const [packed] = JSON.parse(r.stdout) as { filename: string }[];
    if (!packed) throw new Error("npm pack produced no package.");
    return join(outDir, packed.filename);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function ownPackageName(root = packageRoot()): Promise<string> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")).name;
}

/** Copies each secret from the old keychain service to the new one, then deletes the old copy. Returns what moved. */
export async function migrateKeychain(from: Keychain, to: Keychain): Promise<SecretName[]> {
  const moved: SecretName[] = [];
  for (const name of await from.list()) {
    const value = await from.get(name);
    if (value === null) continue;
    if ((await to.get(name)) === null) await to.set(name, value);
    // Deleted only once the new copy reads back, so a failed write never loses a token.
    if ((await to.get(name)) !== null) {
      await from.delete(name);
      moved.push(name);
    }
  }
  return moved;
}

export type Swap =
  | { result: "not-needed" }
  | { result: "dev-install" }
  | { result: "swapped"; bin: string }
  | { result: "needs-sudo"; command: string }
  | { result: "failed"; error: string };

/**
 * Replaces the `productgit` bridge with the `productmaxxing` package. `npm uninstall` of the old package also removes
 * the `pmx` link, so the old one goes first and the new one is installed right after; if that install fails, the
 * bridge goes back, so this Mac always keeps a working `pmx`.
 */
export async function swapPackage(exec: Exec, root = packageRoot()): Promise<Swap> {
  if ((await ownPackageName(root)) !== OLD.pkg) return { result: "not-needed" };
  if (await isDevInstall(root)) return { result: "dev-install" };
  const dir = await mkdtemp(join(tmpdir(), "pmx-rename-"));
  const p = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, root], { timeoutMs: 120000 });
  if (p.code !== 0) return { result: "failed", error: `npm pack failed: ${p.stderr.trim()}` };
  const bridge = join(dir, (JSON.parse(p.stdout) as { filename: string }[])[0]!.filename);
  const next = await repackAs(bridge, NEW_PKG, dir, exec);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const r = await exec("sh", ["-c", `npm uninstall -g ${OLD.pkg} && npm install -g ${q(next)} || { npm install -g ${q(bridge)}; exit 1; }`], { timeoutMs: 300000 });
  if (r.code === 0) {
    const prefix = (await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 })).stdout.trim();
    return { result: "swapped", bin: join(prefix, "bin", "pmx") };
  }
  if (/EACCES|permission denied/i.test(r.stderr)) return { result: "needs-sudo", command: `sudo npm uninstall -g ${OLD.pkg} && sudo npm install -g "${next}"` };
  return { result: "failed", error: r.stderr.trim().split("\n").slice(-3).join(" ") || `npm exited ${r.code}` };
}

/**
 * Re-registers the background job under its new name with this pmx's paths, keeping the Claude Code it pinned. The old
 * job is stopped last: when this runs inside it, launchd ends the process there, after the new job is in place.
 */
export async function migrateLaunchd(o: { exec: Exec; launchd: Launchd; cli: string; node: string }): Promise<boolean> {
  const file = oldLaunchAgent();
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return false;
  await o.launchd.install(plist({ node: o.node, cli: o.cli, pmxHome: pmxHome(), claude: jobEnv(raw).PMX_CLAUDE }));
  await rm(file, { force: true });
  await updateState((s) => (s.renamed = { ...(s.renamed ?? {}), launchd: new Date().toISOString() })).catch(() => {});
  await o.exec("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${OLD.label}`]);
  return true;
}

/** What's left of the old names on this Mac, for `pmx doctor`. */
export async function renameLeftovers(oldKeychain?: Keychain): Promise<string[]> {
  const left: string[] = [];
  if ((await ownPackageName().catch(() => NEW_PKG)) === OLD.pkg) left.push(`the npm package is still "${OLD.pkg}"`);
  if (await stat(oldLaunchAgent()).then(() => true, () => false)) left.push(`the background job is still ${OLD.label}`);
  const keys = oldKeychain ? await oldKeychain.list().catch(() => []) : [];
  if (keys.length) left.push(`${keys.length} keychain item(s) are still under "${OLD.keychain}"`);
  return left;
}

/**
 * Runs before every command except the MCP server and uninstall. Does nothing once this Mac has moved. Never throws:
 * a step that fails is retried next time and named by `pmx doctor`. Returns an exit code when it handed the command
 * over to the new `pmx`, which then already ran it.
 */
export async function migrateFromProductGit(o: { exec: Exec; launchd: Launchd; cli: string; argv: string[]; say: (s: string) => void; keychain?: { from: Keychain; to: Keychain } }): Promise<number | null> {
  try {
    const st = await loadState();
    const name = await ownPackageName();
    if (st.renamed?.keychain && name !== OLD.pkg && !(await stat(oldLaunchAgent()).then(() => true, () => false))) return null;
    if (!st.renamed?.keychain) {
      const kc = o.keychain ?? { from: macKeychain(o.exec, OLD.keychain), to: macKeychain(o.exec) };
      const moved = await migrateKeychain(kc.from, kc.to);
      await updateState((s) => (s.renamed = { ...(s.renamed ?? {}), keychain: new Date().toISOString() }));
      if (moved.length) o.say(`ProductMaxxing: moved ${moved.length} keychain item(s) from "${OLD.keychain}" to "${NEW_PKG}".`);
    }
    if (name === OLD.pkg) {
      const r = await swapPackage(o.exec);
      if (r.result === "swapped") {
        o.say(`ProductGit is now ProductMaxxing: replaced the "${OLD.pkg}" package with "${NEW_PKG}". Your settings and data are unchanged.`);
        const run = spawnSync(r.bin, o.argv, { stdio: "inherit" });
        return run.status ?? 1;
      }
      if (r.result === "needs-sudo") o.say(`ProductGit is now ProductMaxxing. PMX can't replace its package without sudo; run:\n  ${r.command}`);
      else if (r.result === "failed") o.say(`ProductGit is now ProductMaxxing, but replacing the package failed (${r.error}). pmx keeps working; \`pmx doctor\` says how to finish.`);
      return null;
    }
    if (await migrateLaunchd({ exec: o.exec, launchd: o.launchd, cli: o.cli, node: await stableNode(process.execPath) })) o.say(`ProductMaxxing: the background job is now ${LAUNCHD_LABEL}.`);
  } catch {}
  return null;
}
