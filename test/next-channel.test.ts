// The `next` channel (COMPAT-1): a tag vX.Y.Z-next.N is a test build of X.Y.Z, published as a GitHub prerelease and
// under npm's dist-tag `next`. It comes before the release it tests, so everything that orders versions (the team
// minimum, the team package, update steps, what's new) treats it as not there yet; nothing that asks for "the latest"
// ever takes one; and `pmx update --next` is how a tester's Mac gets one, checked against SHA256SUMS like a release.
// GitHub and npm are stand-ins here: nothing leaves this Mac.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { nextUpdateMessage, releaseCheckMessage } from "../src/commands/index.js";
import { runInit } from "../src/commands/init.js";
import { runStatus } from "../src/commands/status.js";
import { scriptedAsker } from "../src/core/ask.js";
import { loadTeamConfig } from "../src/core/config.js";
import { exec, execOk, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { loadState, updateState } from "../src/core/state.js";
import { teamUpdate } from "../src/core/team-update.js";
import { installLatestRelease, installNextRelease, installTeamVersion, latestRelease, nextRelease, releaseAsset } from "../src/core/update.js";
import { applies, upgradeOnStart, type AutoStep } from "../src/core/upgrade.js";
import { assertTeamVersion, atLeast, compareVersions, isPrerelease, isVersion } from "../src/core/version.js";
import { notesBetween, testBuildNote } from "../src/core/whats-new.js";
import { freshHome, git, pmxRepo, quietOut, testCtx, tmp } from "./helpers.js";

// The version this pmx says it is, for the tests that put a Mac on a test build. Null: the real one.
const running = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("../src/core/version.js", async (original) => {
  const real = await original<typeof import("../src/core/version.js")>();
  return { ...real, currentVersion: () => running.version ?? real.currentVersion() };
});

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** GitHub's releases for the public repo: the list, "latest" as GitHub works it out, and each release's two files. */
function github(releases: { tag: string; prerelease?: boolean; draft?: boolean; sums?: string }[]) {
  const asked: string[] = [];
  const pkg = (tag: string) => Buffer.from(`package ${tag}`);
  const fetch = (async (url: string) => {
    asked.push(url);
    if (url.endsWith("/releases/latest")) {
      // GitHub's rule: the newest release that is neither a draft nor a prerelease.
      const latest = releases.find((r) => !r.prerelease && !r.draft);
      return latest ? new Response(JSON.stringify({ tag_name: latest.tag, prerelease: false })) : new Response("", { status: 404 });
    }
    if (/\/releases\?per_page=\d+$/.test(url)) return new Response(JSON.stringify(releases.map((r) => ({ tag_name: r.tag, prerelease: !!r.prerelease, draft: !!r.draft }))));
    for (const r of releases) {
      const v = r.tag.replace(/^v/, "");
      if (url === releaseAsset(v)) return new Response(pkg(r.tag));
      if (url === releaseAsset(v, "SHA256SUMS")) return new Response(r.sums ?? `${sha(pkg(r.tag))}  productmaxxing-${v}.tgz\n`);
    }
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

/** npm as a stand-in that records what it was asked to install. */
function npm() {
  const installs: string[][] = [];
  const run: Exec = async (cmd, args) => {
    if (cmd === "npm" && args[0] === "install") installs.push(args);
    if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: "/usr/local\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec: run, installs };
}

beforeEach(() => { running.version = null; });

describe("a test build comes before the release it tests (COMPAT-1)", () => {
  it("orders 0.40.3 < 0.41.0-next.1 < 0.41.0-next.2 < 0.41.0-next.10 < 0.41.0 < 0.41.1-next.1", () => {
    const order = ["0.40.3", "0.41.0-next.1", "0.41.0-next.2", "0.41.0-next.10", "0.41.0", "0.41.1-next.1", "0.41.1", "1.0.0-next.1", "1.0.0"];
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < order.length; j++)
        expect([order[i], order[j], compareVersions(order[i]!, order[j]!)]).toEqual([order[i], order[j], Math.sign(i - j)]);
    expect([...order].reverse().sort((a, b) => compareVersions(a, b)!)).toEqual(order);
    // As semantic versioning orders suffixes: numbers by value and before words, the shorter first. A leading v is fine.
    expect(compareVersions("0.41.0-next.2", "0.41.0-next.10")).toBe(-1);
    expect(compareVersions("0.41.0-next", "0.41.0-next.1")).toBe(-1);
    expect(compareVersions("0.41.0-1", "0.41.0-next.1")).toBe(-1);
    expect(compareVersions("v0.41.0-next.2", "0.41.0-next.2")).toBe(0);
    expect(compareVersions("0.41.0+build.5", "0.41.0")).toBe(0);
    expect(compareVersions("next", "0.41.0")).toBeNull();
  });

  it("knows a test build from a release", () => {
    expect(isPrerelease("0.41.0-next.2")).toBe(true);
    expect(isPrerelease("v0.41.0-next.2")).toBe(true);
    expect(isPrerelease("0.41.0")).toBe(false);
    expect(isPrerelease("not a version")).toBe(false);
    expect(isPrerelease(undefined)).toBe(false);
    expect(isVersion("0.41.0-next.2")).toBe(true);
  });

  it("a number written with a leading zero isn't a version: npm refuses 0.41.0-next.01, so nothing here takes it for next.1", async () => {
    for (const v of ["0.41.0-next.01", "v0.41.0-next.01", "0.41.0-next.00", "0.41.0-01", "0.041.0", "00.41.0", "0.41.00", "0.41.01-next.1"]) {
      expect([v, isVersion(v), isPrerelease(v)]).toEqual([v, false, false]);
      expect([v, compareVersions(v, "0.41.0"), compareVersions("0.41.0-next.1", v)]).toEqual([v, null, null]);
      expect([v, atLeast("0.41.0", v), atLeast("99.0.0", v)]).toEqual([v, false, false]); // a minimum that can't be read is never met; the config check below refuses it first
    }
    // Zero itself is a number, and a word may start with one.
    for (const v of ["0.0.0", "0.41.0-next.0", "10.20.30-next.100", "0.41.0-0", "0.41.0-0a.1"]) expect([v, isVersion(v)]).toEqual([v, true]);
    expect(compareVersions("0.41.0-next.0", "0.41.0-next.1")).toBe(-1);
    // A team can't set one as its minimum.
    const { repo } = await pmxRepo();
    const file = join(repo, "pmx.config.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), cli: { min: "0.41.0-next.01" } }));
    await expect(loadTeamConfig(repo)).rejects.toThrow(/cli\.min must be a version like 0\.5\.0, not "0\.41\.0-next\.01"/);
  });

  it("the whole text has to be the version: 0.41.0.1, 0.41 and 0.41.0 with words after it aren't 0.41.0", async () => {
    for (const v of ["0.41.0.1", "0.41", "41", "0.41.0abc", "0.41.0 or so", "0.41.0 (Claude Code)", "pmx 0.41.0", "0.41.0-", "0.41.0-next..1", "0.41.0-next.1.", "0.41.0-next.1 x", "0.41.0+", "0.41.0-next_1", "vv0.41.0", "0.41.0\n0.42.0", ""]) {
      expect([v, isVersion(v), isPrerelease(v)]).toEqual([v, false, false]);
      expect([v, compareVersions(v, "0.41.0"), compareVersions("0.41.0", v), compareVersions(v, v)]).toEqual([v, null, null, null]);
      expect([v, atLeast("99.0.0", v)]).toEqual([v, false]);
      expect(() => assertTeamVersion({ cli: { min: v || "x" } }, "99.0.0")).toThrow(/your team needs/);
    }
    // Still versions: a leading v, spaces around it, and build metadata, which never counts.
    expect(compareVersions(" v0.41.0\n", "0.41.0")).toBe(0);
    expect(compareVersions("0.41.0+build.5", "0.41.0")).toBe(0);
    expect(compareVersions("0.41.0-next.2+sha.abc", "0.41.0-next.2")).toBe(0);
    expect(isPrerelease("0.41.0+next.2")).toBe(false);
    // A team can't set one as its minimum, as before.
    const { repo } = await pmxRepo();
    const file = join(repo, "pmx.config.json");
    for (const min of ["0.41.0.1", "0.41", "0.41.0abc"]) {
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), cli: { min } }));
      await expect(loadTeamConfig(repo)).rejects.toThrow(`cli.min must be a version like 0.5.0, not "${min}"`);
    }
  });

  it("a team package whose version isn't one is no package: nothing is installed for it", async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    for (const version of ["99.0.0.1", "99.0", "99.0.0abc", "99.0.0-next.01"]) {
      const n = npm();
      const run: Exec = async (cmd, args, o) => (cmd === "tar" ? { code: 0, stdout: JSON.stringify({ version }), stderr: "" } : n.exec(cmd, args, o));
      expect([version, await installTeamVersion("/repo", run)]).toEqual([version, { result: "no-package" }]);
      expect(n.installs).toEqual([]);
    }
  });

  it("a team minimum of 0.41.0 isn't met by a test build of it; a minimum that is a test build is met by it and by the release", async () => {
    expect(atLeast("0.41.0-next.2", "0.41.0")).toBe(false);
    expect(atLeast("0.41.0-next.2", "0.40.3")).toBe(true);
    expect(() => assertTeamVersion({ cli: { min: "0.41.0" } }, "0.41.0-next.2")).toThrow(/runs pmx 0\.41\.0-next\.2, and your team needs 0\.41\.0 or newer/);
    for (const v of ["0.41.0-next.2", "0.41.0-next.3", "0.41.0"]) expect(() => assertTeamVersion({ cli: { min: "0.41.0-next.2" } }, v)).not.toThrow();
    expect(() => assertTeamVersion({ cli: { min: "0.41.0-next.2" } }, "0.41.0-next.1")).toThrow();
    // The test rig's team repo may require a test build: `pmx vendor --require` on a tester's Mac writes it.
    const { repo } = await pmxRepo();
    const file = join(repo, "pmx.config.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), cli: { min: "0.41.0-next.2" } }));
    expect((await loadTeamConfig(repo)).cli).toMatchObject({ min: "0.41.0-next.2" });
  });

  it("what's new: a test build shows nothing of the release it tests, and the release then shows its own notes", () => {
    expect(notesBetween("0.11.0", "0.12.0-next.3")).toEqual([]);
    expect(notesBetween("0.12.0-next.3", "0.12.0").map((n) => n.version)).toEqual(["0.12.0"]);
    expect(notesBetween("0.10.0", "0.12.0-next.3").map((n) => n.version)).toEqual(["0.11.0", "0.10.1"]);
    expect(testBuildNote("0.41.0-next.2")).toMatch(/^pmx 0\.41\.0-next\.2 is a test build of 0\.41\.0, not a release\..*blob\/v0\.41\.0-next\.2\/CHANGELOG\.md/);
    expect(testBuildNote("0.41.0")).toBeNull();
  });
});

describe("the team's package is installed whatever it is; a test build never outranks its release (COMPAT-6)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
  });
  const vendored = (version: string) => {
    const n = npm();
    const run: Exec = async (cmd, args, o) => (cmd === "tar" ? { code: 0, stdout: JSON.stringify({ version }), stderr: "" } : n.exec(cmd, args, o));
    return { exec: run, installs: n.installs };
  };

  it("a Mac on a release takes the test build its team's repo carries (the test rig); a Mac on a test build takes the release", async () => {
    running.version = "0.40.3";
    expect(await installTeamVersion("/repo", vendored("0.41.0-next.2").exec)).toEqual({ result: "updated", version: "0.41.0-next.2" });
    running.version = "0.41.0-next.1";
    expect(await installTeamVersion("/repo", vendored("0.41.0-next.2").exec)).toEqual({ result: "updated", version: "0.41.0-next.2" });
    running.version = "0.41.0-next.2";
    expect(await installTeamVersion("/repo", vendored("0.41.0").exec)).toEqual({ result: "updated", version: "0.41.0" });
    // Never back: not to an older test build, and not from the release to a test build of it.
    const older = vendored("0.41.0-next.1");
    expect(await installTeamVersion("/repo", older.exec)).toEqual({ result: "current", version: "0.41.0-next.1" });
    running.version = "0.41.0";
    const back = vendored("0.41.0-next.9");
    expect(await installTeamVersion("/repo", back.exec)).toEqual({ result: "current", version: "0.41.0-next.9" });
    expect([...older.installs, ...back.installs]).toEqual([]);
  });
});

describe("an update step since 0.41.0 is due on a test build of 0.41.0 (UPGRADE-1)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("pmx-claude-"); });
  const deps = () => ({ exec: (async () => ({ code: 1, stdout: "", stderr: "" })) as Exec, launchd: fakeLaunchd(), cliPath: "/x/cli.js", interactive: true, devInstall: async () => false });

  it("applies to a Mac that comes from 0.40.3, and still to one on an earlier test build", () => {
    const step = { id: "s", since: "0.41.0", title: "s", run: async () => null } as AutoStep;
    expect(applies(step, "0.40.3", "0.41.0-next.1")).toBe(true);
    expect(applies(step, "0.41.0-next.1", "0.41.0-next.2")).toBe(true);
    expect(applies(step, "0.41.0-next.2", "0.41.0")).toBe(true);
    expect(applies(step, "0.41.0", "0.41.1-next.1")).toBe(false);
    expect(applies({ ...step, since: "0.41.0-next.2" } as AutoStep, "0.41.0-next.2", "0.41.0")).toBe(false);
  });

  it("runs once on the first test build, a step added by a later build runs there, and the release runs neither again", async () => {
    const ran: string[] = [];
    const mk = (id: string, since: string | null): AutoStep => ({ id, since, title: id, run: async () => { ran.push(id); return `did ${id}`; } });
    // What every command does on every new version: five of them, so the record of them is trimmed after eight builds.
    const every = ["a", "b", "c", "d", "e"].map((id) => mk(`every-${id}`, null));
    const first = mk("since-0.41", "0.41.0"), later = mk("added-in-next-2", "0.41.0"), old = mk("since-0.40", "0.40.0");
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.upgrade = { lastVersion: "0.40.3", from: "0.40.3", at: "2026-11-26T09:00:00.000Z", applied: {} }; });
    const at = async (version: string, steps: AutoStep[]) => {
      running.version = version;
      ran.length = 0;
      const r = await upgradeOnStart(deps(), steps);
      expect(r.to).toBe(version);
      return ran.filter((id) => !id.startsWith("every-"));
    };

    // The rig's Mac, from the last release to the first test build: the step for 0.41.0 runs, as it will for every team.
    expect(await at("0.41.0-next.1", [...every, old, first])).toEqual(["since-0.41"]);
    expect((await loadState()).upgrade).toMatchObject({ from: "0.40.3", lastVersion: "0.41.0-next.1" });
    expect(await at("0.41.0-next.1", [...every, old, first])).toEqual([]);
    // The next build adds a step for 0.41.0: it runs on that Mac too, and the first one doesn't run twice.
    expect(await at("0.41.0-next.2", [...every, old, first, later])).toEqual(["added-in-next-2"]);
    // Many builds later the record has been trimmed many times over, and neither one-off step has run again.
    for (let n = 3; n <= 14; n++) expect(await at(`0.41.0-next.${n}`, [...every, old, first, later])).toEqual([]);
    const rec = (await loadState()).upgrade!;
    expect(rec).toMatchObject({ from: "0.41.0-next.13", lastVersion: "0.41.0-next.14" });
    expect(Object.keys(rec.applied)).toEqual(expect.arrayContaining(["since-0.41", "added-in-next-2"]));
    expect(Object.keys(rec.applied).filter((k) => k.includes("@"))).toHaveLength(40);
    // The release itself: nothing one-off is left to do, and the next release starts from it.
    expect(await at("0.41.0", [...every, old, first, later])).toEqual([]);
    expect(await at("0.41.1", [...every, old, first, later])).toEqual([]);
    expect((await loadState()).upgrade).toMatchObject({ from: "0.41.0", lastVersion: "0.41.1" });
  });

  it("a Mac that skips the test builds runs the same steps on the release", async () => {
    const ran: string[] = [];
    const step: AutoStep = { id: "since-0.41", since: "0.41.0", title: "s", run: async () => { ran.push("since-0.41"); return "did"; } };
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.upgrade = { lastVersion: "0.40.3", from: "0.40.3", at: "2026-11-26T09:00:00.000Z", applied: {} }; });
    running.version = "0.41.0";
    await upgradeOnStart(deps(), [step]);
    expect(ran).toEqual(["since-0.41"]);
  });
});

describe("nothing that asks for the latest release takes a test build (COMPAT-2, INSTALL-1)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("pmx update --latest asks GitHub for its latest release, which leaves prereleases out, and never lists releases", async () => {
    const gh = github([{ tag: "v99.1.0-next.2", prerelease: true }, { tag: "v99.0.0" }, { tag: "v98.0.0" }]);
    const n = npm();
    expect(await latestRelease(gh.fetch)).toEqual({ version: "99.0.0" });
    expect(await installLatestRelease(n.exec, { fetch: gh.fetch })).toEqual({ result: "updated", version: "99.0.0" });
    expect(n.installs[0]!.at(-1)).toMatch(/productmaxxing-99\.0\.0\.tgz$/);
    expect(gh.asked.some((u) => u.includes("per_page"))).toBe(false);
    expect(gh.asked.some((u) => u.includes("next"))).toBe(false);
  });

  it("a test build named as the latest by mistake (published without the prerelease mark) is refused, and nothing is installed", async () => {
    const unmarked = (async (url: string) => (url.endsWith("/releases/latest") ? new Response(JSON.stringify({ tag_name: "v99.1.0-next.2" })) : new Response("", { status: 404 }))) as typeof fetch;
    const marked = (async (url: string) => (url.endsWith("/releases/latest") ? new Response(JSON.stringify({ tag_name: "v99.1.0", prerelease: true })) : new Response("", { status: 404 }))) as typeof fetch;
    const n = npm();
    for (const f of [unmarked, marked]) {
      expect(await latestRelease(f)).toEqual({ error: expect.stringMatching(/GitHub named a test build \(99\.1\.0(-next\.2)?\) as the latest release/) });
      expect(await installLatestRelease(n.exec, { fetch: f })).toMatchObject({ result: "failed", error: expect.stringContaining("test build") });
    }
    expect(n.installs).toEqual([]);
  });

  it("a latest release tagged with a leading zero is no version at all, to --latest and --next alike", async () => {
    const odd = (async (url: string) => (url.endsWith("/releases/latest") ? new Response(JSON.stringify({ tag_name: "v99.1.0-next.01" })) : url.includes("per_page") ? new Response(JSON.stringify([{ tag_name: "v99.1.0-next.01", prerelease: true }, { tag_name: "v099.0.0" }])) : new Response("", { status: 404 }))) as typeof fetch;
    const n = npm();
    expect(await latestRelease(odd)).toEqual({ error: 'the latest release on GitHub is tagged "v99.1.0-next.01", which isn\'t a version' });
    expect(await installLatestRelease(n.exec, { fetch: odd })).toEqual({ result: "failed", version: "?", error: 'the latest release on GitHub is tagged "v99.1.0-next.01", which isn\'t a version' });
    // The same for a tag that only starts like a version, and a release with no tag says that instead.
    const tagged = (tag_name?: string) => (async (url: string) => (url.endsWith("/releases/latest") ? new Response(JSON.stringify({ tag_name })) : new Response("", { status: 404 }))) as typeof fetch;
    for (const tag of ["v99.1.0.1", "v99.1", "nightly", "v99.1.0 final"]) expect(await latestRelease(tagged(tag))).toEqual({ error: `the latest release on GitHub is tagged "${tag}", which isn't a version` });
    expect(await latestRelease(tagged())).toEqual({ error: "the latest release on GitHub has no tag" });
    expect(await latestRelease(tagged("v99.1.0"))).toEqual({ version: "99.1.0" });
    expect(await nextRelease(odd)).toEqual({ error: "GitHub lists no release with a version tag" });
    expect(await installNextRelease(n.exec, { fetch: odd })).toMatchObject({ result: "failed", error: "GitHub lists no release with a version tag" });
    expect(n.installs).toEqual([]);
  });

  it("pmx vendor --latest refuses the same way: nothing reaches the team's repo", async () => {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const unmarked = (async (url: string) => (url.endsWith("/releases/latest") ? new Response(JSON.stringify({ tag_name: "v99.1.0-next.2" })) : new Response("", { status: 404 }))) as typeof fetch;
    const before = await git(origin!, "for-each-ref");
    const r = await teamUpdate(repo, { exec, fetch: unmarked, confirm: async () => true, say: () => {} });
    expect(r).toEqual({ result: "refused", why: expect.stringMatching(/test build \(99\.1\.0-next\.2\).*nothing was changed/) });
    expect(await git(origin!, "for-each-ref")).toBe(before);
  });

  it("pmx doctor leaves out a latest version that is a test build, and still warns about a newer release", async () => {
    const dir = await tmp();
    const keychain = memoryKeychain(), launchd = fakeLaunchd();
    const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));
    const personal = await runInit({ askAll: true,
      ask: scriptedAsker({ "PMX repo checkout": join(dir, "pmx"), "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(dir, "t"), "email domains": "acme.com" }),
      keychain, launchd, exec: withClaude, out: quietOut(), now: () => new Date(), cliPath: "/x/cli.js",
    });
    const team = await loadTeamConfig(personal.repoPath);
    const latest = async (v: string) => {
      await updateState((s) => { s.cloudVersions = { latest: v, min: null, seenAt: new Date().toISOString() }; });
      return (await runDoctor({ personal, team, keychain, launchd, exec: withClaude })).find((c) => c.id === "cli.latest");
    };
    expect(await latest("99.0.0-next.1")).toBeUndefined();
    expect(await latest("99.0.0")).toMatchObject({ ok: false, level: "warn", detail: "latest release is pmx 99.0.0" });
  });

  it("the release workflow publishes a -next tag as a GitHub prerelease under npm's dist-tag next, and a plain tag as before", async () => {
    const wf = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
    // The one place a test build is told from a release: only vX.Y.Z-next.N sets TEST_BUILD, with no number written
    // with a leading zero, which npm would refuse at the very end of the run.
    expect(wf).toContain("n='(0|[1-9][0-9]*)'");
    expect(wf).toContain('if [[ "$GITHUB_REF_NAME" =~ ^v$n\\.$n\\.$n-next\\.$n$ ]]; then\n            echo "TEST_BUILD=1" >> "$GITHUB_ENV"');
    // Both additions expand to nothing while TEST_BUILD is unset, so a release's two commands are the ones it always ran.
    expect(wf).toContain('--title "pmx ${GITHUB_REF_NAME#v}" ${TEST_BUILD:+--prerelease} \\');
    expect(wf).toContain('npm publish "./productmaxxing-$v.tgz" --access public ${TEST_BUILD:+--tag next}');
    expect(wf.match(/TEST_BUILD/g)).toHaveLength(4); // its comment, the one place it's set, the two places it's read, and nothing else
    expect(wf.indexOf("TEST_BUILD=1")).toBeLessThan(wf.indexOf("npm ci"));
    // npm trusts this workflow by its file name, and tags are what start it.
    expect(wf).toMatch(/^name: Release\non:\n  push:\n    tags: \["v\*"\]$/m);
  });

  it("the workflow's own step, run on each kind of tag: a release passes untouched, a test build is marked, and a tag npm would refuse stops with one line saying why", async () => {
    const wf = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
    // The step's script, exactly as the workflow has it, run by bash the way GitHub runs a step (`bash -e`).
    const step = wf.match(/      - name: a release, or a test build for the next channel\n        run: \|\n((?:          .*\n)+)/)![1]!.replace(/^ {10}/gm, "");
    const dir = await tmp("workflow-step-");
    const tag = async (name: string) => {
      const env = join(dir, `env-${name}`);
      await writeFile(env, "");
      const r = await exec("bash", ["-e", "-c", step], { env: { ...process.env, GITHUB_REF_NAME: name, GITHUB_ENV: env }, timeoutMs: 20000 });
      return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim(), env: await readFile(env, "utf8") };
    };

    // A release: nothing printed, nothing set, so every later step runs exactly as it did before there were test builds.
    for (const name of ["v0.41.0", "v1.0.0", "v10.20.30", "v0.0.0"]) expect([name, await tag(name)]).toEqual([name, { code: 0, out: "", err: "", env: "" }]);
    // A test build: marked, and it says so.
    for (const name of ["v0.41.0-next.1", "v0.41.0-next.0", "v0.41.0-next.12", "v10.0.0-next.100"])
      expect([name, await tag(name)]).toEqual([name, { code: 0, out: `${name} is a test build: a GitHub prerelease, and npm's dist-tag next`, err: "", env: "TEST_BUILD=1\n" }]);
    // A number written with a leading zero, in a test build or a release: stopped before the tests, with the rule it broke.
    for (const name of ["v0.41.0-next.01", "v0.41.0-next.00", "v0.041.0-next.1", "v00.41.0-next.1", "v0.41.00-next.1", "v0.041.0", "v0.41.00", "v01.0.0"])
      expect([name, await tag(name)]).toEqual([name, { code: 1, out: "", err: `Stopped before anything was published: the tag ${name} has a number written with a leading zero, which npm refuses as a version. Write each number plainly: next.1, not next.01.`, env: "" }]);
    // Any other suffix: stopped too, with the other rule.
    for (const name of ["v0.41.0-rc.1", "v0.41.0-next", "v0.41.0-next.2x", "v0.41.0-beta.01", "v0.41.0-next.1.2", "v0.41.0-next.1-next.2"])
      expect([name, await tag(name)]).toEqual([name, { code: 1, out: "", err: `Stopped before anything was published: the tag ${name} has a suffix that isn't -next.N. A release is vX.Y.Z, and a test build is vX.Y.Z-next.N.`, env: "" }]);
    // No hyphen, and still not vX.Y.Z: these went on as releases, with only "tag matches package.json" before them.
    for (const name of ["v0.41.0.1", "v0.41", "v1.2.3+build", "vbanana", "v0.41.0.", "v.41.0", "0.41.0", "V0.41.0", "v0.41.0 "])
      expect([name, await tag(name)]).toEqual([name, { code: 1, out: "", err: `Stopped before anything was published: the tag ${name} isn't a version of three numbers. A release is vX.Y.Z, and a test build is vX.Y.Z-next.N.`, env: "" }]);
  });
});

describe("pmx update --next: a tester's Mac takes the newest build, checked like a release", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
  });

  it("picks the highest version among the releases, test builds included, whatever order GitHub lists them in", async () => {
    const list = [{ tag: "v99.0.0" }, { tag: "v99.1.0-next.011", prerelease: true }, { tag: "v99.09.0" }, { tag: "v99.1.0-next.10", prerelease: true }, { tag: "v99.1.0-next.9", prerelease: true }, { tag: "v99.2.0-next.1", prerelease: true, draft: true }, { tag: "v99.3.0-rc.1", prerelease: true }, { tag: "nightly" }];
    expect(await nextRelease(github(list).fetch)).toEqual({ version: "99.1.0-next.10", test: true });
    // Once the release a test build led to is out, it's the newest: --next never goes back to a test build.
    expect(await nextRelease(github([{ tag: "v99.1.0" }, ...list]).fetch)).toEqual({ version: "99.1.0", test: false });
    expect(await nextRelease(github([{ tag: "nightly" }]).fetch)).toEqual({ error: "GitHub lists no release with a version tag" });
    expect(await nextRelease((async () => new Response("", { status: 403 })) as typeof fetch)).toEqual({ error: "couldn't read the releases from GitHub (HTTP 403)" });
  });

  it("installs the test build only when it matches the release's SHA256SUMS, and says it's a test build", async () => {
    const n = npm();
    const bad = github([{ tag: "v99.1.0-next.2", prerelease: true, sums: `${"0".repeat(64)}  productmaxxing-99.1.0-next.2.tgz\n` }, { tag: "v99.0.0" }]);
    expect(await installNextRelease(n.exec, { fetch: bad.fetch })).toMatchObject({ result: "failed", version: "99.1.0-next.2", error: expect.stringContaining("doesn't match the release's SHA256SUMS") });
    expect(n.installs).toEqual([]);

    const good = github([{ tag: "v99.1.0-next.2", prerelease: true }, { tag: "v99.0.0" }]);
    const r = await installNextRelease(n.exec, { fetch: good.fetch });
    expect(r).toEqual({ result: "updated", version: "99.1.0-next.2", test: true });
    expect(n.installs).toHaveLength(1);
    expect(n.installs[0]!.slice(0, 2)).toEqual(["install", "-g"]);
    expect(n.installs[0]!.at(-1)).toMatch(/productmaxxing-99\.1\.0-next\.2\.tgz$/);
    expect(good.asked.some((u) => u.endsWith("/releases/latest"))).toBe(false);
    expect((await loadState()).whatsNew?.since).toBeTruthy(); // the new pmx says what changed since this one, as after any update

    const said = nextUpdateMessage(r, "99.0.0");
    expect(said).toMatch(/^Installed pmx 99\.1\.0-next\.2, a test build of 99\.1\.0\. It isn't a release/);
    expect(said).toContain("pmx update --latest and pmx vendor --latest never pick it");
  });

  it("does nothing when no build is newer, and says which kind this Mac runs", async () => {
    const n = npm();
    running.version = "99.1.0-next.2";
    const same = await installNextRelease(n.exec, { fetch: github([{ tag: "v99.1.0-next.2", prerelease: true }, { tag: "v99.0.0" }]).fetch });
    expect(same).toEqual({ result: "current", version: "99.1.0-next.2", test: true });
    expect(nextUpdateMessage(same, "99.1.0-next.2")).toBe("pmx 99.1.0-next.2 is a test build, and no newer build is out.");
    // The release is out: --next moves the tester's Mac to it, and says it's a release.
    const out = await installNextRelease(n.exec, { fetch: github([{ tag: "v99.1.0" }, { tag: "v99.1.0-next.2", prerelease: true }]).fetch });
    expect(out).toEqual({ result: "updated", version: "99.1.0", test: false });
    expect(nextUpdateMessage(out, "99.1.0-next.2")).toBe("Installed pmx 99.1.0, the newest release: no test build is newer.");
    running.version = "99.1.0";
    const none = await installNextRelease(n.exec, { fetch: github([{ tag: "v99.1.0" }, { tag: "v99.1.0-next.2", prerelease: true }]).fetch });
    expect(nextUpdateMessage(none, "99.1.0")).toBe("pmx 99.1.0 is a release, and no test build is newer.");
    expect(n.installs).toHaveLength(1);
  });

  it("--check says what is out and that nothing was installed, on both channels", () => {
    // A release's Mac, with a test build out.
    expect(releaseCheckMessage("next", { version: "99.1.0-next.2", test: true }, "99.0.0")).toBe("pmx 99.1.0-next.2, a test build of 99.1.0, is out, and this Mac runs pmx 99.0.0. Nothing was installed: pmx update --next installs it.");
    // A tester's Mac, once the release is out.
    expect(releaseCheckMessage("next", { version: "99.1.0", test: false }, "99.1.0-next.2")).toBe("pmx 99.1.0, a release, is the newest build, and this Mac runs pmx 99.1.0-next.2. Nothing was installed: pmx update --next installs it.");
    // Nothing newer: the same words as the update itself.
    expect(releaseCheckMessage("next", { version: "99.1.0-next.2", test: true }, "99.1.0-next.2")).toBe("pmx 99.1.0-next.2 is a test build, and no newer build is out.");
    expect(releaseCheckMessage("latest", { version: "99.1.0" }, "99.0.0")).toBe("pmx 99.1.0 is the latest release, and this Mac runs pmx 99.0.0. Nothing was installed: pmx update --latest installs it.");
    expect(releaseCheckMessage("latest", { version: "99.0.0" }, "99.0.0")).toBe("pmx 99.0.0 is the latest release.");
    expect(releaseCheckMessage("latest", { version: "99.0.0" }, "99.1.0-next.2")).toBe("pmx 99.1.0-next.2 is a test build, newer than the latest release (99.0.0), so nothing was installed. To go back to that release: pmx update --latest --force");
  });
});

describe("pmx status on a test build", () => {
  beforeEach(freshHome);

  it("doesn't ask the team lead to share a test build; on a release it still does", async () => {
    const { repo } = await pmxRepo();
    const pkg = await tmp("pkg-");
    await mkdir(join(pkg, "package"), { recursive: true });
    await writeFile(join(pkg, "package", "package.json"), JSON.stringify({ name: "productmaxxing", version: "99.0.0" }));
    await mkdir(join(repo, ".pmx", "cli"), { recursive: true });
    await execOk("tar", ["-czf", join(repo, ".pmx", "cli", "productmaxxing.tgz"), "-C", pkg, "package"]);
    const line = async () => (await runStatus(await testCtx({ repo }))).split("\n").find((l) => l.startsWith("Team package:"));

    running.version = "99.1.0-next.2";
    expect(await line()).toBe("Team package: pmx 99.0.0 in the team repo, this Mac runs 99.1.0-next.2, a test build: your team's repo carries releases, so there is nothing to share");
    running.version = "99.1.0";
    expect(await line()).toBe("Team package: pmx 99.0.0 in the team repo, this Mac runs 99.1.0: teammates who run pmx update get the older one (team lead: pmx vendor --require)");
    // A test build older than the team's package is still told to update.
    running.version = "98.0.0-next.1";
    expect(await line()).toBe("Team package: pmx 99.0.0 in the team repo, this Mac runs 98.0.0-next.1: run pmx update");
  }, 30000);
});
