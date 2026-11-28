import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { readJson, writeJson } from "./fsutil.js";
import { TEAM_CONFIG_FILE } from "./paths.js";
import { packageRoot } from "./skills.js";
import { BRIDGE_CLI, OLD, repackAs } from "./rename.js";

/** Where a PMX repo keeps the CLI package its PMs and its CI install. */
export const VENDORED_CLI = ".pmx/cli/productmaxxing.tgz";

/**
 * Every file `vendorCli` writes: the package, and the bridge older Macs read (RENAME-1). A function, not a constant:
 * rename.ts is in an import cycle with this module, so BRIDGE_CLI isn't ready while this module loads.
 */
export const vendoredFiles = (): string[] => [VENDORED_CLI, BRIDGE_CLI];

/**
 * What `pmx vendor` says (R10): each file it wrote by name, and to commit them all. With `--require` that's the team
 * config too. A team that committed only the package left the bridge out, and Macs on 0.14.0 or older never moved over.
 */
export function vendorMessage(o: { repo: string; version: string; config?: string | null; autoUpdate?: boolean }): string {
  // COMPAT-6: on unless the team turned it off, so only an explicit false means teammates update by hand.
  const auto = o.autoUpdate !== false;
  const files = [...vendoredFiles(), ...(o.config ? [o.config] : [])];
  const list = `${files.slice(0, -1).join(", ")} and ${files.at(-1)}`;
  return [
    `Wrote ${VENDORED_CLI} (productmaxxing ${o.version}) and ${BRIDGE_CLI} (the same build, for teammates' Macs on PMX 0.14.0 or older) in ${o.repo}.`,
    ...(o.config ? [`Set cli.min to ${o.version} in ${o.config}: older machines keep personal work but stop shared team work until they update.${auto ? " Auto-update is on: each machine's background job installs it within the hour of the merge (--no-auto-update turns that off)." : " Auto-update is off for your team (cli.autoUpdate is false): each teammate runs \`pmx update\` (--auto-update turns it back on)."}`] : []),
    `Commit ${files.length === 2 ? "both" : "all three"} files (${list}) in a PR of its own. ${auto ? "Once it merges, teammates' Macs install it by themselves within the hour; \`pmx update\` does it at once." : "Teammates update with \`pmx update\`."}`,
  ].join("\n");
}

/**
 * `pmx vendor --require` and `pmx vendor --latest`: makes `version` the team's minimum in the repo's pmx.config.json.
 * `autoUpdate` sets `cli.autoUpdate`; undefined keeps what the file says. Returns whether auto-update is on afterwards
 * (COMPAT-6: on unless the file says false).
 */
export async function setTeamMinimum(repo: string, version: string, autoUpdate?: boolean): Promise<boolean> {
  const file = join(repo, TEAM_CONFIG_FILE);
  const raw = (await readJson<Record<string, unknown>>(file)) ?? {};
  const prev = (raw.cli ?? {}) as { autoUpdate?: boolean };
  const auto = autoUpdate ?? prev.autoUpdate;
  await writeJson(file, { ...raw, cli: { min: version, ...(auto !== undefined ? { autoUpdate: auto } : {}) } }, 0o644);
  return auto !== false;
}

export async function cliVersion(): Promise<string> {
  return JSON.parse(await readFile(join(packageRoot(), "package.json"), "utf8")).version;
}

/**
 * Packs the running CLI into the PMX repo. Teammates install that exact build with
 * `npm install -g .pmx/cli/productmaxxing.tgz`, and the run-record CI check installs it from the
 * base branch, so every machine and CI compute fingerprints with the same version.
 * Works from an installed copy too: it packs the package's own files, without build scripts.
 */
export async function vendorCli(repoPath: string, exec: Exec): Promise<string> {
  const dir = join(repoPath, ".pmx", "cli");
  await mkdir(dir, { recursive: true });
  const r = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir, packageRoot()], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`npm pack failed: ${r.stderr.trim()}`);
  const [packed] = JSON.parse(r.stdout) as { filename: string; version: string }[];
  if (!packed) throw new Error("npm pack produced no package.");
  await rename(join(dir, packed.filename), join(repoPath, VENDORED_CLI));
  // RENAME-1: teammates still on 0.14.0 or older look for .pmx/cli/productgit.tgz and can only update a package of
  // that name. The bridge is the same build packed as "productgit"; on its first run it moves the Mac over.
  const bridge = await repackAs(join(repoPath, VENDORED_CLI), OLD.pkg, dir, exec);
  await rename(bridge, join(repoPath, BRIDGE_CLI));
  return packed.version;
}
