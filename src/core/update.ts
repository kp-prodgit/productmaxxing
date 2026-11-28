import { createHash } from "node:crypto";
import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";
import { VENDORED_CLI } from "./vendor.js";
import { markUpdatingFrom } from "./whats-new.js";
import { compareVersions, currentVersion, isPrerelease, isVersion, vendoredVersion } from "./version.js";

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
  const latest = await latestRelease(o.fetch);
  if ("error" in latest) return { result: "failed", version: "?", error: latest.error };
  const { version } = latest;
  if ((compareVersions(version, currentVersion()) ?? 0) <= 0 && !o.force) return { result: "current", version };
  if (await isDevInstall()) return { result: "dev-install", version };
  const pkg = await downloadRelease(version, o.fetch);
  if ("error" in pkg) return { result: "failed", version, error: pkg.error };
  return npmInstall(pkg.tgz, version, exec);
}

const RELEASES_API = "https://api.github.com/repos/kp-prodgit/productmaxxing/releases";
const GITHUB_JSON = { headers: { accept: "application/vnd.github+json" } };

/**
 * The newest public release's version, from GitHub. Never a test build: GitHub's "latest release" leaves out releases
 * marked as prereleases, which is how the release workflow marks every `-next.N` tag, and a tag with a suffix is
 * refused here too, in case one was ever published without that mark. `pmx update --latest` and `pmx vendor --latest`
 * both ask this, so neither a Mac nor a team's repo gets a test build by asking for the latest.
 */
export async function latestRelease(get: typeof fetch = fetch): Promise<{ version: string } | { error: string }> {
  const res = await get(`${RELEASES_API}/latest`, GITHUB_JSON).catch(() => null);
  if (!res?.ok) return { error: `couldn't read the latest release from GitHub${res ? ` (HTTP ${res.status})` : ""}` };
  const body = (await res.json()) as { tag_name?: string; prerelease?: boolean };
  const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
  const version = tag.replace(/^v/, "");
  if (!tag) return { error: "the latest release on GitHub has no tag" };
  if (!isVersion(version)) return { error: `the latest release on GitHub is tagged "${tag}", which isn't a version` };
  if (isPrerelease(version) || body.prerelease === true) return { error: `GitHub named a test build (${version}) as the latest release, and --latest only takes releases` };
  return { version };
}

/**
 * The newest build on the `next` channel: the highest version among the public releases, test builds (`-next.N`)
 * included. Once the release a test build led to is out, that release is the newest, so `--next` never goes back to an
 * older test build. Drafts and tags that aren't versions don't count.
 */
export async function nextRelease(get: typeof fetch = fetch): Promise<{ version: string; test: boolean } | { error: string }> {
  const res = await get(`${RELEASES_API}?per_page=30`, GITHUB_JSON).catch(() => null);
  if (!res?.ok) return { error: `couldn't read the releases from GitHub${res ? ` (HTTP ${res.status})` : ""}` };
  const list = (await res.json().catch(() => null)) as { tag_name?: string; draft?: boolean }[] | null;
  const versions = (Array.isArray(list) ? list : []).filter((r) => r && r.draft !== true).map((r) => String(r.tag_name ?? "").replace(/^v/, ""))
    // A suffix other than next.N isn't a channel PMX publishes, and a number with a leading zero (next.01) isn't a
    // version npm could have published.
    .filter((v) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-next\.(0|[1-9]\d*))?$/.test(v));
  const version = versions.sort((a, b) => compareVersions(b, a) ?? 0)[0];
  if (!version) return { error: "GitHub lists no release with a version tag" };
  return { version, test: isPrerelease(version) };
}

/**
 * `pmx update --next`: for a tester's Mac. Installs the newest build, test builds included, checked against its
 * SHA256SUMS exactly as `--latest` checks a release. Never run by the background job, and never what a team gets by
 * `pmx vendor --latest`. `test` says whether what it found is a test build, so the command can say so.
 */
export async function installNextRelease(exec: Exec, o: { force?: boolean; fetch?: typeof fetch } = {}): Promise<UpdateOutcome & { test?: boolean }> {
  const next = await nextRelease(o.fetch);
  if ("error" in next) return { result: "failed", version: "?", error: next.error };
  const { version, test } = next;
  if ((compareVersions(version, currentVersion()) ?? 0) <= 0 && !o.force) return { result: "current", version, test };
  if (await isDevInstall()) return { result: "dev-install", version, test };
  const pkg = await downloadRelease(version, o.fetch);
  if ("error" in pkg) return { result: "failed", version, error: pkg.error };
  return { ...(await npmInstall(pkg.tgz, version, exec)), test };
}

/**
 * A release's package, downloaded into a folder of its own and checked against the release's SHA256SUMS; a package
 * that doesn't match is never written. Shared by `pmx update --latest`, which installs it on this Mac, and
 * `pmx vendor --latest`, which puts it in the team's repo.
 */
export async function downloadRelease(version: string, get: typeof fetch = fetch): Promise<{ tgz: string; sha256: string } | { error: string }> {
  const name = `productmaxxing-${version}.tgz`;
  const [pkg, sums] = await Promise.all([get(releaseAsset(version)), get(releaseAsset(version, "SHA256SUMS"))].map((p) => p.catch(() => null)));
  if (!pkg?.ok || !sums?.ok) return { error: `couldn't download ${name} and SHA256SUMS from ${RELEASES}/tag/v${version}` };
  const bytes = Buffer.from(await pkg.arrayBuffer());
  const want = (await sums.text()).split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === name)?.[0];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (!want || want.toLowerCase() !== got) return { error: `${name} doesn't match the release's SHA256SUMS, so it wasn't installed` };
  const tgz = join(await mkdtemp(join(tmpdir(), "pmx-release-")), name);
  await writeFile(tgz, bytes);
  return { tgz, sha256: got };
}

/** COMPAT-7: how PMX Engine's own updater (`pmxe update`) ended, as src/engine/bridge.ts reads it. */
export type EngineUpdate =
  | { result: "updated"; from: string; to: string }
  | { result: "current"; version: string }
  /** Engine doesn't update while a release is being sent. */
  | { result: "refused" }
  | { result: "failed"; error: string };

/** One sentence for each way Engine's update can end. PMX's own update counts as done whatever it says. */
export function engineUpdateLine(r: EngineUpdate): string {
  switch (r.result) {
    case "updated": return `PMX Engine: updated from ${r.from} to ${r.to}, and its own update steps ran (pmxe checklist shows anything left for you).`;
    case "current": return `PMX Engine ${r.version} is the latest too.`;
    case "refused": return "PMX Engine wasn't updated: it doesn't update while a release is being sent, so finish sending it, then run pmx update again.";
    case "failed": return `PMX Engine's update didn't finish (${r.error.replace(/\.$/, "")}); PMX's own update is done, and pmxe update tries Engine's again.`;
  }
}

/**
 * COMPAT-7: one update. After PMX's own, `pmx update` runs PMX Engine's updater where Engine is on this Mac. Only from a
 * command a person runs (`interactive`): the background job installs the team's PMX only (src/commands/autoupdate.ts),
 * never Engine, whose update can refuse or ask. `run` is the bridge's `runEngineUpdate`, null without Engine.
 */
export async function updateEngineToo(run: () => Promise<EngineUpdate | null>, o: { interactive: boolean }): Promise<string | null> {
  if (!o.interactive) return null;
  const r = await run().catch((e: unknown): EngineUpdate => ({ result: "failed", error: e instanceof Error ? e.message : String(e) }));
  return r ? engineUpdateLine(r) : null;
}
