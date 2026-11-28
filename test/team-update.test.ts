// COMPAT-2 (0.41.0): `pmx vendor --latest`, the team's admin's one command. It gets the newest release, checked against
// its SHA256SUMS, puts it in the team's repo with the bridge for older Macs, raises cli.min, and sends one commit on a
// branch of its own as a pull request. The remote here is a bare repo in a temp folder, `gh` is a stand-in that only
// records what it was asked, and nothing reaches GitHub or npm.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { scriptedAsker } from "../src/core/ask.js";
import { exec, execOk, type Exec } from "../src/core/exec.js";
import { teamUpdate, teamUpdateBody, teamUpdateBranch, teamUpdateMessage, type TeamUpdate } from "../src/core/team-update.js";
import { releaseAsset } from "../src/core/update.js";
import { freshHome, git, pmxRepo, tmp } from "./helpers.js";

const V = "99.1.0";
const BRANCH = `pmx/update-${V}`;
const FILES = [".pmx/cli/productgit.tgz", ".pmx/cli/productmaxxing.tgz", "pmx.config.json"];

/** A real package tarball for version `v`, as a release carries it. */
async function releasePackage(v = V): Promise<Buffer> {
  const dir = await tmp("release-");
  await mkdir(join(dir, "package"), { recursive: true });
  await writeFile(join(dir, "package", "package.json"), JSON.stringify({ name: "productmaxxing", version: v, bin: { pmx: "dist/src/cli.js" } }));
  await execOk("tar", ["-czf", join(dir, "p.tgz"), "-C", dir, "package"]);
  return readFile(join(dir, "p.tgz"));
}

/** GitHub's release API and assets for one release. `sums`: what SHA256SUMS says, the package's real hash unless given. */
function release(pkg: Buffer, o: { sums?: string; v?: string } = {}) {
  const v = o.v ?? V;
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: `v${v}` }));
    if (url === releaseAsset(v)) return new Response(pkg);
    if (url === releaseAsset(v, "SHA256SUMS")) return new Response(o.sums ?? `${createHash("sha256").update(pkg).digest("hex")}  productmaxxing-${v}.tgz\n`);
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

/**
 * git and tar run for real against the temp repos. `npm pack` (the bridge for older Macs) is a stand-in that writes the
 * file it would. `gh` is a stand-in: signed in or not, and it records each call.
 */
function tools(o: { gh?: "signed-in" | "signed-out" | "missing" | "pr-fails" } = {}) {
  const gh: string[][] = [];
  const calls: string[][] = [];
  const run: Exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") {
      gh.push(args);
      const mode = o.gh ?? "signed-in";
      if (mode === "missing") return { code: 1, stdout: "", stderr: "spawn gh ENOENT" };
      if (args[0] === "auth") return mode === "signed-out" ? { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." } : { code: 0, stdout: "", stderr: "" };
      if (args[0] === "pr" && mode === "pr-fails") return { code: 1, stdout: "", stderr: "pull request create failed: something went wrong" };
      if (args[0] === "pr") return { code: 0, stdout: "https://github.com/northfield/pmx-team/pull/7\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unknown" };
    }
    if (cmd === "npm" && args[0] === "pack") {
      const out = args[args.indexOf("--pack-destination") + 1]!;
      const pkg = JSON.parse(await readFile(join(args.at(-1)!, "package.json"), "utf8"));
      await writeFile(join(out, `${pkg.name}-${pkg.version}.tgz`), `bridge for ${pkg.name} ${pkg.version}`);
      return { code: 0, stdout: JSON.stringify([{ filename: `${pkg.name}-${pkg.version}.tgz`, version: pkg.version }]), stderr: "" };
    }
    if (cmd === "npm") return { code: 1, stdout: "", stderr: "npm is never run for real here" };
    return exec(cmd, args, opts);
  };
  return { exec: run, gh, calls };
}

/** The team's repo on the admin's Mac, with a bare remote, and what the remote holds. */
async function teamRepo() {
  const { repo, origin } = await pmxRepo({}, { remote: true });
  const remote = (...a: string[]) => git(origin!, ...a);
  return { repo, origin: origin!, remote };
}

const said = () => { const lines: string[] = []; return { lines, say: (l: string) => lines.push(l) }; };

describe("pmx vendor --latest: one command to update a team (COMPAT-2)", () => {
  beforeEach(freshHome);

  it("sends the newest release as one commit on its own branch and opens the pull request with gh", async () => {
    const { repo, origin, remote } = await teamRepo();
    const pkg = await releasePackage();
    const t = tools(), out = said(), asked: string[] = [];
    const mainBefore = await remote("rev-parse", "refs/heads/main");
    const headBefore = await git(repo, "rev-parse", "HEAD");
    const configBefore = await git(repo, "config", "--list", "--local");

    const r = await teamUpdate(repo, { exec: t.exec, fetch: release(pkg).fetch, say: out.say, confirm: async (q) => (asked.push(q), true) });
    expect(r).toEqual({ result: "opened", version: V, branch: BRANCH, base: "main", url: "https://github.com/northfield/pmx-team/pull/7", pr: true });
    expect(teamUpdateBranch(V)).toBe(BRANCH);

    // One commit on the remote's new branch, off main, touching only the package, the bridge and the team's settings.
    expect(await remote("rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(await remote("rev-parse", `${BRANCH}~1`)).toBe(mainBefore);
    expect((await remote("diff", "--name-only", "main", BRANCH)).split("\n").sort()).toEqual(FILES);
    expect(await remote("log", "-1", "--format=%s", BRANCH)).toBe(`Update the team to pmx ${V}`);
    // The package is the release's own bytes, and cli.min is the release.
    const tgz = join(await tmp("out-"), "p.tgz");
    await execOk("sh", ["-c", `git --git-dir "$0" show "$1:.pmx/cli/productmaxxing.tgz" > "$2"`, origin, BRANCH, tgz]);
    expect((await readFile(tgz)).equals(pkg)).toBe(true);
    const cfg = JSON.parse(await remote("show", `${BRANCH}:pmx.config.json`));
    expect(cfg.cli).toEqual({ min: V });
    expect(cfg.team).toBe("test");
    expect(await remote("show", `${BRANCH}:.pmx/cli/productgit.tgz`)).toBe(`bridge for productgit ${V}`);

    // It asked once, saying what it pushes and where, and never the default branch.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(new RegExp(`as the branch ${BRANCH.replace(/[./]/g, "\\$&")} and open a pull request against main\\?$`));
    const pushes = t.calls.filter((c) => c[0] === "git" && c[1] === "push");
    expect(pushes).toEqual([["git", "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`]]);
    expect(out.lines.join("\n")).toMatch(/matches the release's SHA256SUMS/);

    // gh: signed in, then one pull request against main from the branch, with the package's hash in its body.
    expect(t.gh.map((a) => a.slice(0, 2))).toEqual([["auth", "status"], ["pr", "create"]]);
    const pr = t.gh[1]!;
    expect(pr.slice(pr.indexOf("--base"), pr.indexOf("--base") + 4)).toEqual(["--base", "main", "--head", BRANCH]);
    expect(pr[pr.indexOf("--title") + 1]).toBe(`Update the team to pmx ${V}`);
    expect(pr[pr.indexOf("--body") + 1]).toContain(createHash("sha256").update(pkg).digest("hex"));

    // The admin's own checkout is as it was: same commit, same branch, clean, no new branch, no leftover worktree,
    // and not one git setting changed.
    expect(await git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(repo, "branch", "--show-current")).toBe("main");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await git(repo, "branch", "--list", "pmx/*")).toBe("");
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
    expect(await git(repo, "config", "--list", "--local")).toBe(configBefore);
    expect(teamUpdateMessage(r)).toEqual({ code: 0, text: `Opened the pull request: https://github.com/northfield/pmx-team/pull/7\nOnce it merges, every Mac on your team, this one too, installs pmx ${V} by itself within the hour (pmx update does it at once), unless your team turned auto-update off.` });
  });

  it("without gh, or signed out, or when gh fails, it still pushes and says where to open the pull request", async () => {
    for (const mode of ["missing", "signed-out", "pr-fails"] as const) {
      const { repo, origin } = await teamRepo();
      // A remote whose address reads like GitHub's, in a temp folder: nothing here reaches GitHub.
      const hub = join(await tmp("hub-"), "github.com", "northfield", "pmx-team.git");
      await mkdir(join(hub, ".."), { recursive: true });
      await rename(origin, hub);
      await git(repo, "remote", "set-url", "origin", hub);
      const remote = (...a: string[]) => git(hub, ...a);
      const t = tools({ gh: mode }), out = said();
      const r = await teamUpdate(repo, { exec: t.exec, fetch: release(await releasePackage()).fetch, say: out.say, confirm: async () => true });
      expect(r, mode).toEqual({ result: "opened", version: V, branch: BRANCH, base: "main", url: `https://github.com/northfield/pmx-team/compare/main...${BRANCH}?expand=1`, pr: false });
      expect(await remote("rev-parse", "--verify", BRANCH)).toMatch(/^[0-9a-f]{40}$/);
      expect(t.gh.some((a) => a[0] === "pr")).toBe(mode === "pr-fails");
      expect(teamUpdateMessage(r).text).toMatch(new RegExp(`^Pushed ${BRANCH.replace(/[./]/g, "\\$&")}\\. Open the pull request: https://github\\.com/northfield/pmx-team/compare/main\\.\\.\\.`));
      if (mode === "pr-fails") expect(out.lines.join("\n")).toMatch(/gh couldn't open the pull request \(pull request create failed/);
    }
    // A remote that isn't on GitHub has no link to give: it says which branch, into which.
    const off: TeamUpdate = { result: "opened", version: V, branch: BRANCH, base: "main", url: null, pr: false };
    expect(teamUpdateMessage(off).text).toMatch(new RegExp(`^Pushed ${BRANCH.replace(/[./]/g, "\\$&")}\\. Open a pull request from it into main on your git host\\.`));
  });

  it("pushes nothing when the admin says no, and nothing is left behind", async () => {
    const { repo, remote } = await teamRepo();
    const t = tools();
    const refs = await remote("for-each-ref", "--format=%(refname)");
    const r = await teamUpdate(repo, { exec: t.exec, fetch: release(await releasePackage()).fetch, say: () => {}, confirm: async () => false });
    expect(r).toEqual({ result: "declined", version: V });
    expect(await remote("for-each-ref", "--format=%(refname)")).toBe(refs);
    expect(t.calls.filter((c) => c[0] === "git" && c[1] === "push")).toEqual([]);
    expect(t.gh).toEqual([]);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await git(repo, "branch", "--list", "pmx/*")).toBe("");
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
    expect(teamUpdateMessage(r)).toEqual({ code: 1, text: "Nothing was pushed. To push without being asked: pmx vendor --latest --yes" });
  });

  it("refuses while the package or the team's settings have uncommitted changes, before it downloads anything", async () => {
    for (const dirty of ["pmx.config.json", ".pmx/cli/productmaxxing.tgz"]) {
      const { repo, remote } = await teamRepo();
      await mkdir(join(repo, ".pmx", "cli"), { recursive: true });
      await writeFile(join(repo, dirty), dirty.endsWith(".json") ? `${await readFile(join(repo, dirty), "utf8")}\n` : "half-made");
      const before = await readFile(join(repo, dirty), "utf8");
      const t = tools(), rel = release(await releasePackage());
      const r = await teamUpdate(repo, { exec: t.exec, fetch: rel.fetch, say: () => {}, confirm: async () => { throw new Error("never asked"); } });
      expect(r).toMatchObject({ result: "refused", why: expect.stringMatching(new RegExp(`has uncommitted changes in .*${dirty.split("/").pop()!.replace(/\./g, "\\.")}.*nothing was changed`)) });
      expect(rel.asked).toEqual([]);
      expect(await readFile(join(repo, dirty), "utf8")).toBe(before);
      expect(await remote("for-each-ref", "--format=%(refname)", "refs/heads/pmx")).toBe("");
      expect(teamUpdateMessage(r).code).toBe(1);
    }
    // Changes elsewhere in the checkout are the admin's own business: the update is made off the remote's main.
    const { repo, remote } = await teamRepo();
    await writeFile(join(repo, "notes.md"), "mine");
    const r = await teamUpdate(repo, { exec: tools().exec, fetch: release(await releasePackage()).fetch, say: () => {}, confirm: async () => true });
    expect(r.result).toBe("opened");
    expect((await remote("diff", "--name-only", "main", BRANCH)).split("\n").sort()).toEqual(FILES);
    expect(await readFile(join(repo, "notes.md"), "utf8")).toBe("mine");
  });

  it("never puts a package in the repo that doesn't match the release's SHA256SUMS", async () => {
    const { repo, remote } = await teamRepo();
    const t = tools();
    const r = await teamUpdate(repo, { exec: t.exec, fetch: release(await releasePackage(), { sums: `${"0".repeat(64)}  productmaxxing-${V}.tgz\n` }).fetch, say: () => {}, confirm: async () => { throw new Error("never asked"); } });
    expect(r).toMatchObject({ result: "refused", why: expect.stringMatching(/doesn't match the release's SHA256SUMS; nothing was changed/) });
    expect(await remote("for-each-ref", "--format=%(refname)", "refs/heads/pmx")).toBe("");
    expect(t.calls.filter((c) => c[0] === "git" && (c[1] === "push" || c[1] === "commit"))).toEqual([]);
    expect((await git(repo, "worktree", "list")).split("\n")).toHaveLength(1);
  });

  it("says so when the team already has the newest release, or its branch is already pushed", async () => {
    const { repo, remote } = await teamRepo();
    const pkg = await releasePackage();
    const first = await teamUpdate(repo, { exec: tools().exec, fetch: release(pkg).fetch, say: () => {}, confirm: async () => true });
    expect(first.result).toBe("opened");
    // Run again before the pull request merges: nothing new is pushed.
    const again = await teamUpdate(repo, { exec: tools().exec, fetch: release(pkg).fetch, say: () => {}, confirm: async () => { throw new Error("never asked"); } });
    expect(again).toMatchObject({ result: "exists", branch: BRANCH, base: "main" });
    expect(teamUpdateMessage(again).text).toMatch(/is already in your team's repo, from an earlier run/);
    // Once it merged (and the branch is gone, as after a merge), the team is current.
    await remote("update-ref", "refs/heads/main", await remote("rev-parse", BRANCH));
    await remote("update-ref", "-d", `refs/heads/${BRANCH}`);
    const t = tools(), rel = release(pkg);
    const done = await teamUpdate(repo, { exec: t.exec, fetch: rel.fetch, say: () => {}, confirm: async () => { throw new Error("never asked"); } });
    expect(done).toEqual({ result: "current", version: V });
    expect(rel.asked.filter((u) => /\.tgz$|SHA256SUMS$/.test(u))).toEqual([]);
    expect(teamUpdateMessage(done)).toEqual({ code: 0, text: `Your team's repo already carries pmx ${V}, the newest release, and requires it. Nothing to do.` });
  });

  it("keeps the team's choice about auto-update unless the admin changes it, and refuses a repo with no remote", async () => {
    const { repo, remote } = await teamRepo();
    const cfgFile = join(repo, "pmx.config.json");
    await writeFile(cfgFile, JSON.stringify({ ...JSON.parse(await readFile(cfgFile, "utf8")), cli: { min: "0.5.0", autoUpdate: false } }, null, 2));
    await git(repo, "commit", "-qam", "auto-update off");
    await git(repo, "push", "-q", "origin", "main");
    const pkg = await releasePackage();
    await teamUpdate(repo, { exec: tools().exec, fetch: release(pkg).fetch, say: () => {}, confirm: async () => true });
    expect(JSON.parse(await remote("show", `${BRANCH}:pmx.config.json`)).cli).toEqual({ min: V, autoUpdate: false });
    expect(teamUpdateBody({ version: V, sha256: "abc", autoUpdate: false })).toMatch(/turned auto-update off .* each teammate runs `pmx update`/);
    expect(teamUpdateBody({ version: V, sha256: "abc", autoUpdate: true })).toMatch(/each teammate's Mac installs it by itself within the hour/);

    const solo = await pmxRepo();
    const r = await teamUpdate(solo.repo, { exec: tools().exec, fetch: release(pkg).fetch, say: () => {}, confirm: async () => true });
    expect(r).toMatchObject({ result: "refused", why: expect.stringMatching(/has no remote, so there's no pull request to open/) });
  });

  it("the command asks before pushing, --yes skips the question, and the three older commands are still there", async () => {
    const { repo, remote } = await teamRepo();
    const cmd = commands.find((c) => c.name === "vendor")!;
    expect(Object.keys(cmd.options).sort()).toEqual(["auto-update", "latest", "no-auto-update", "repo", "require", "yes"]);
    expect(cmd.usage).toMatch(/pmx vendor --latest \[--yes\]/);
    expect(commands.find((c) => c.name === "update")!.options).toHaveProperty("latest");

    // The command reaches GitHub's API through the real fetch, so here it's pointed at a release that can't be read:
    // it stops before anything is pushed and exits 1, with the reason.
    const realFetch = globalThis.fetch;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
    try {
      const code = await cmd.run({ values: { latest: true, repo }, positionals: [], ask: scriptedAsker({}), ctx: async () => { throw new Error("not used"); }, cliPath: "/x/cli.js" });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/couldn't read the latest release from GitHub \(HTTP 503\); nothing was changed/);
    } finally { globalThis.fetch = realFetch; console.log = log; }
    expect(await remote("for-each-ref", "--format=%(refname)", "refs/heads/pmx")).toBe("");
  });
});
