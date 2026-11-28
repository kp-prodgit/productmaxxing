import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "./exec.js";
import { readJson } from "./fsutil.js";
import { Git } from "./git.js";
import { parseGitHubRemote } from "./host.js";
import { TEAM_CONFIG_FILE } from "./paths.js";
import { BRIDGE_CLI, OLD, repackAs } from "./rename.js";
import { downloadRelease, latestRelease, RELEASES } from "./update.js";
import { setTeamMinimum, VENDORED_CLI, vendoredFiles } from "./vendor.js";
import { compareVersions, vendoredVersion } from "./version.js";

/**
 * `pmx vendor --latest` (COMPAT-2, 0.41.0): the team's admin moves the team to the newest PMX with one command. It
 * downloads the newest public release, checked against the release's SHA256SUMS exactly as `pmx update --latest`
 * checks it, puts that package in the team's repo with the bridge for older Macs, raises `cli.min`, and sends it as a
 * pull request: one commit on a branch of its own that touches only `.pmx/cli/*` and `pmx.config.json`.
 *
 * It works in a worktree off the remote's default branch, so the admin's own checkout and branch are never touched and
 * no local branch is made. It asks once before it pushes, pushes only its own branch (never the default one), refuses
 * while those paths have uncommitted changes, and never changes a git setting. Nothing is installed on this Mac: it
 * gets the version like every other Mac, once the pull request merges.
 */
export interface TeamUpdateDeps {
  exec: Exec;
  fetch?: typeof fetch;
  /** Asked once, with what's about to be pushed and where. False pushes nothing. */
  confirm: (question: string) => Promise<boolean>;
  say: (line: string) => void;
  /** `--auto-update` or `--no-auto-update`; undefined keeps what the team's settings say. */
  autoUpdate?: boolean;
}

export type TeamUpdate =
  /** Pushed. `pr`: gh opened the pull request at `url`; otherwise `url` is where to open it, or null off GitHub. */
  | { result: "opened"; version: string; branch: string; base: string; url: string | null; pr: boolean }
  | { result: "current"; version: string }
  /** An earlier run already pushed this version's branch. */
  | { result: "exists"; version: string; branch: string; base: string; url: string | null }
  | { result: "declined"; version: string }
  | { result: "refused"; why: string };

/** The files the commit may touch, and nothing else. */
const paths = () => [...vendoredFiles(), TEAM_CONFIG_FILE];
export const teamUpdateBranch = (version: string) => `pmx/update-${version}`;
const NET_MS = 120000;
const last = (t: string) => t.trim().split("\n").filter(Boolean).pop() ?? "";

export function teamUpdateBody(o: { version: string; sha256: string; autoUpdate: boolean }): string {
  return [
    `Moves the team to PMX ${o.version} (${RELEASES}/tag/v${o.version}).`,
    "",
    `- \`${VENDORED_CLI}\`: the release's package, as published. SHA-256 \`${o.sha256}\`, which matches the release's SHA256SUMS.`,
    `- \`${BRIDGE_CLI}\`: the same build under PMX's old package name, for Macs on PMX 0.14.0 or older.`,
    `- \`${TEAM_CONFIG_FILE}\`: \`cli.min\` is now ${o.version}. Older Macs keep personal work but stop shared team work until they update.`,
    "",
    o.autoUpdate
      ? "Once this merges, each teammate's Mac installs it by itself within the hour, and tells them what's new and whether anything is left for them."
      : "Your team turned auto-update off (`cli.autoUpdate` is false), so once this merges each teammate runs `pmx update`.",
    "",
    "Made by `pmx vendor --latest`.",
  ].join("\n");
}

/** The remote's own default branch, asked of the remote; this checkout's idea of it only when the remote doesn't say. */
async function remoteDefault(git: Git): Promise<string> {
  const r = await git.raw(["ls-remote", "--symref", "origin", "HEAD"], { timeoutMs: NET_MS });
  const m = r.code === 0 ? r.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m) : null;
  return m ? m[1]! : git.defaultBranch();
}

export async function teamUpdate(repo: string, d: TeamUpdateDeps): Promise<TeamUpdate> {
  const git = new Git(repo, d.exec);
  if ((await git.raw(["rev-parse", "--show-toplevel"])).code !== 0) return { result: "refused", why: `${repo} isn't a git repository.` };
  const remote = await git.remoteUrl();
  if (!remote) return { result: "refused", why: `${repo} has no remote, so there's no pull request to open. Run \`pmx update --latest\`, then \`pmx vendor --require\`, and commit ${paths().join(", ")} on your main branch.` };
  const dirty = await git.raw(["status", "--porcelain", "--untracked-files=all", "--", ".pmx/cli", TEAM_CONFIG_FILE]);
  if (dirty.code !== 0) return { result: "refused", why: `Couldn't read ${repo}'s status: ${last(dirty.stderr)}` };
  if (dirty.stdout.trim()) {
    const files = dirty.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
    return { result: "refused", why: `${repo} has uncommitted changes in ${files.join(", ")}. Commit or discard them first; nothing was changed.` };
  }
  const fetched = await git.raw(["fetch", "--quiet", "origin"], { timeoutMs: NET_MS });
  if (fetched.code !== 0) return { result: "refused", why: `Couldn't reach your team's repo (${last(fetched.stderr) || "git fetch failed"}); nothing was changed.` };
  const base = await remoteDefault(git);
  if ((await git.raw(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])).code !== 0) return { result: "refused", why: `Your team's repo has no ${base} branch to open a pull request against.` };

  const latest = await latestRelease(d.fetch);
  if ("error" in latest) return { result: "refused", why: `${latest.error}; nothing was changed.` };
  const { version } = latest;
  const branch = teamUpdateBranch(version);
  // Its own branch, always: this is the one place a push is named, and it can never name the default branch.
  if (branch === base) return { result: "refused", why: `Your team's default branch is ${base}, the branch this update would use. Nothing was pushed.` };
  const gh = parseGitHubRemote(remote);
  const compare = gh ? `https://github.com/${gh.owner}/${gh.repo}/compare/${base}...${branch}?expand=1` : null;
  const there = await git.raw(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { timeoutMs: NET_MS });
  if (there.code === 0 && there.stdout.trim()) return { result: "exists", version, branch, base, url: compare };

  const work = await mkdtemp(join(tmpdir(), "pmx-team-update-"));
  const wt = join(work, "repo");
  let release: string | null = null;
  try {
    await git.ok(["worktree", "add", "--detach", "--quiet", wt, `refs/remotes/origin/${base}`]);
    const tree = new Git(wt, d.exec);
    const cfg = ((await readJson<Record<string, unknown>>(join(wt, TEAM_CONFIG_FILE)).catch(() => null))?.cli ?? {}) as { min?: string; autoUpdate?: boolean };
    const carried = await vendoredVersion(join(wt, VENDORED_CLI), d.exec);
    const atLeast = (v: string | null | undefined) => !!v && (compareVersions(v, version) ?? -1) >= 0;
    if (atLeast(carried) && atLeast(cfg.min)) return { result: "current", version };

    const pkg = await downloadRelease(version, d.fetch);
    if ("error" in pkg) return { result: "refused", why: `${pkg.error.replace(", so it wasn't installed", "")}; nothing was changed.` };
    release = dirname(pkg.tgz);
    await mkdir(join(wt, ".pmx", "cli"), { recursive: true });
    await copyFile(pkg.tgz, join(wt, VENDORED_CLI));
    // RENAME-1: the same build under the old package name, for Macs that still look for it.
    await rename(await repackAs(join(wt, VENDORED_CLI), OLD.pkg, join(wt, ".pmx", "cli"), d.exec), join(wt, BRIDGE_CLI));
    const autoUpdate = await setTeamMinimum(wt, version, d.autoUpdate);
    await tree.ok(["add", "--", ...paths()]);
    const staged = (await tree.ok(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (!staged.length) return { result: "current", version };
    const stray = staged.filter((f) => !paths().includes(f));
    if (stray.length) return { result: "refused", why: `The commit would touch ${stray.join(", ")}, which this update never changes. Nothing was pushed.` };
    // The admin's own git name and email, as their git is set up. PMX never sets one.
    const commit = await tree.raw(["commit", "--quiet", "-m", `Update the team to pmx ${version}`]);
    if (commit.code !== 0) return { result: "refused", why: `git couldn't make the commit (${last(commit.stderr) || last(commit.stdout) || "git commit failed"}). PMX never changes your git settings; nothing was pushed.` };

    d.say(`Ready: pmx ${version} for your team, as one commit touching ${staged.join(", ")}.`);
    d.say(`The package matches the release's SHA256SUMS (${pkg.sha256.slice(0, 12)}…).`);
    if (!(await d.confirm(`Push it to ${remote} as the branch ${branch} and open a pull request against ${base}?`))) return { result: "declined", version };
    const pushed = await tree.raw(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], { timeoutMs: NET_MS });
    if (pushed.code !== 0) return { result: "refused", why: `Couldn't push ${branch} (${last(pushed.stderr) || "git push failed"}). Nothing reached your team's repo.` };

    // gh opens the pull request where it's installed and signed in; otherwise the admin opens it from the link.
    const signedIn = (await d.exec("gh", ["auth", "status"], { cwd: repo, timeoutMs: 30000 })).code === 0;
    if (signedIn) {
      const pr = await d.exec("gh", ["pr", "create", ...(gh ? ["--repo", `${gh.owner}/${gh.repo}`] : []), "--base", base, "--head", branch, "--title", `Update the team to pmx ${version}`, "--body", teamUpdateBody({ version, sha256: pkg.sha256, autoUpdate })], { cwd: repo, timeoutMs: NET_MS });
      const url = pr.stdout.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop();
      if (pr.code === 0 && url) return { result: "opened", version, branch, base, url, pr: true };
      d.say(`gh couldn't open the pull request (${last(pr.stderr) || `gh exited ${pr.code}`}).`);
    }
    return { result: "opened", version, branch, base, url: compare, pr: false };
  } catch (e: any) {
    return { result: "refused", why: `${String(e?.message ?? e)}. Nothing was pushed.` };
  } finally {
    await git.raw(["worktree", "remove", "--force", wt]);
    await git.raw(["worktree", "prune"]);
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (release) await rm(release, { recursive: true, force: true }).catch(() => {});
  }
}

/** What `pmx vendor --latest` says at the end, and its exit code. */
export function teamUpdateMessage(r: TeamUpdate): { text: string; code: number } {
  switch (r.result) {
    case "opened":
      return {
        code: 0,
        text: [
          r.pr ? `Opened the pull request: ${r.url}` : r.url ? `Pushed ${r.branch}. Open the pull request: ${r.url}` : `Pushed ${r.branch}. Open a pull request from it into ${r.base} on your git host.`,
          `Once it merges, every Mac on your team, this one too, installs pmx ${r.version} by itself within the hour (pmx update does it at once), unless your team turned auto-update off.`,
        ].join("\n"),
      };
    case "current": return { code: 0, text: `Your team's repo already carries pmx ${r.version}, the newest release, and requires it. Nothing to do.` };
    case "exists": return { code: 0, text: `The branch ${r.branch} is already in your team's repo, from an earlier run. ${r.url ? `Open or find its pull request: ${r.url}` : `Open a pull request from it into ${r.base} on your git host.`}` };
    case "declined": return { code: 1, text: `Nothing was pushed. To push without being asked: pmx vendor --latest --yes` };
    case "refused": return { code: 1, text: r.why };
  }
}
