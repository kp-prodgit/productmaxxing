import { createHash } from "node:crypto";
import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";
import { VENDORED_CLI } from "./vendor.js";
import { markUpdatingFrom } from "./whats-new.js";
import { compareVersions, currentVersion, isVersion, vendoredVersion } from "./version.js";

export type UpdateOutcome =
  | { result: "updated"; version: string }
  | { result: "current"; version: string }
  | { result: "no-package" }
  | { result: "dev-install"; version: string }
  | { result: "needs-sudo"; version: string; command: string }
  | { result: "failed"; version: string; error: string };

const installRoot = () => process.env.PMX_INSTALL_ROOT_FOR_TESTS ?? packageRoot();

/** A pmx run from a source checkout (`npm link` or a symlink to dist): never overwritten by an update. */
export async function isDevInstall(root = installRoot()): Promise<boolean> {
  return stat(join(root, ".git")).then(() => true, () => false);
}

/**
 * The folder this pmx was installed under, when it isn't npm's global folder. A package at
 * `<prefix>/lib/node_modules/productmaxxing` came from `npm install -g --prefix <prefix>` (for example
 * /opt/homebrew, when npm's own folder needs sudo). An update must use the same prefix, or npm asks for sudo
 * in its own folder, or installs a second pmx there that the PATH may never reach.
 */
export async function installPrefix(exec: Exec, root = installRoot()): Promise<string | null> {
  const real = await realpath(root).catch(() => root);
  const modules = dirname(real);
  if (basename(modules) !== "node_modules" || basename(dirname(modules)) !== "lib") return null;
  const prefix = dirname(dirname(modules));
  const r = await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 });
  const global = r.code === 0 ? r.stdout.trim() : "";
  if (global && (await realpath(global).catch(() => global)) === prefix) return null;
  return prefix;
}

/**
 * Installs the CLI package from the PMX repo when it's newer than this one (COMPAT-2, COMPAT-6). Never
 * downgrades. The package is code-owner reviewed in the repo (`/.pmx/cli/` in CODEOWNERS), so this
 * installs only what the team approved. Shared by `pmx update` and the background job.
 */
export async function installTeamVersion(repoPath: string, exec: Exec, o: { force?: boolean; pull?: boolean } = {}): Promise<UpdateOutcome> {
  if (o.pull) await exec("git", ["-C", repoPath, "pull", "--ff-only", "--quiet"], { timeoutMs: 60000 });
  const tgz = join(repoPath, VENDORED_CLI);
  const version = await vendoredVersion(tgz, exec);
  if (!version) return { result: "no-package" };
  if ((compareVersions(version, currentVersion()) ?? 0) <= 0 && !o.force) return { result: "current", version };
  if (await isDevInstall()) return { result: "dev-install", version };
  return npmInstall(tgz, version, exec);
}

async function npmInstall(tgz: string, version: string, exec: Exec): Promise<UpdateOutcome> {
  const prefix = await installPrefix(exec);
  const args = ["install", "-g", ...(prefix ? ["--prefix", prefix] : []), tgz];
  const r = await exec("npm", args, { timeoutMs: 300000 });
  if (r.code === 0) {
    // The new pmx says what changed since this one, once (NEW-1).
    await markUpdatingFrom(currentVersion());
    return { result: "updated", version };
  }
  if (/EACCES|permission denied/i.test(r.stderr)) return { result: "needs-sudo", version, command: `sudo npm install -g ${prefix ? `--prefix "${prefix}" ` : ""}"${tgz}"` };
  return { result: "failed", version, error: r.stderr.trim().split("\n").slice(-3).join(" ") || `npm exited ${r.code}` };
}

/** ProductMaxxing's public releases: a prebuilt package plus SHA256SUMS per version, so installing builds nothing. */
export const RELEASES = "https://github.com/kp-prodgit/productmaxxing/releases";
export const releaseAsset = (version: string, file = `productmaxxing-${version}.tgz`) => `${RELEASES}/download/v${version}/${file}`;

/**
 * `pmx update --latest`: installs the newest public release, checked against its SHA256SUMS. For the
 * team lead, who then shares it with `pmx vendor --require`; everyone else installs the team's package,
 * which code owners review, so this never runs from the background job.
 */
export async function installLatestRelease(exec: Exec, o: { force?: boolean; fetch?: typeof fetch } = {}): Promise<UpdateOutcome> {
  const get = o.fetch ?? fetch;
  const res = await get("https://api.github.com/repos/kp-prodgit/productmaxxing/releases/latest", { headers: { accept: "application/vnd.github+json" } }).catch(() => null);
  if (!res?.ok) return { result: "failed", version: "?", error: `couldn't read the latest release from GitHub${res ? ` (HTTP ${res.status})` : ""}` };
  const version = String(((await res.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "");
  if (!isVersion(version)) return { result: "failed", version: "?", error: `the latest release has no version tag` };
  if ((compareVersions(version, currentVersion()) ?? 0) <= 0 && !o.force) return { result: "current", version };
  if (await isDevInstall()) return { result: "dev-install", version };

  const dir = await mkdtemp(join(tmpdir(), "pmx-release-"));
  const name = `productmaxxing-${version}.tgz`;
  const [pkg, sums] = await Promise.all([get(releaseAsset(version)), get(releaseAsset(version, "SHA256SUMS"))].map((p) => p.catch(() => null)));
  if (!pkg?.ok || !sums?.ok) return { result: "failed", version, error: `couldn't download ${name} and SHA256SUMS from ${RELEASES}/tag/v${version}` };
  const bytes = Buffer.from(await pkg.arrayBuffer());
  const want = (await sums.text()).split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === name)?.[0];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (!want || want.toLowerCase() !== got) return { result: "failed", version, error: `${name} doesn't match the release's SHA256SUMS, so it wasn't installed` };
  const tgz = join(dir, name);
  await writeFile(tgz, bytes);
  return npmInstall(tgz, version, exec);
}
