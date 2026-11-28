// scripts/prepare-release.mjs: the one script that prepares a release or a test build in the working tree. Each test
// runs the script itself on a copy of this repo's own files in a temp folder, so a file whose shape the script no
// longer understands fails here and not on release day. Nothing is committed, tagged, pushed or published by it, and
// these tests give it no git repository to do that in. The script stays in the source repo, so the public repo's tests
// skip this file.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { exec } from "../src/core/exec.js";
import { tmp } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "prepare-release.mjs");
const FILES = ["package.json", "package-lock.json", ".claude-plugin/plugin.json", "INSTALL.md", "README.md", "CHANGELOG.md", "src/core/whats-new.ts", "src/core/upgrade.ts", "test/autoupdate.test.ts"];
// Far ahead of any real version, so these tests hold whatever this repo's version, pins and upgrade steps are today.
const V = "98.0.0";

const BLOCK = ["<!-- whats-new", "- One command moves a team to the newest release.", "  try: pmx vendor --latest", '- Setup asks only what PMX can\'t work out: "two questions", not twenty, and costs $$0 & nothing ($&).', "-->"].join("\n");

/** What test/autoupdate.test.ts looks like to the script: the newer team package it installs, and an older one. */
const fixtureAt = (v: string) => `const NEWER = "${v}";\n\nfakeExec({ vendored: NEWER });\nfakeExec({ vendored: "0.4.0" });\n`;

/**
 * A copy of the files the script reads, with an "Unreleased" section of our own: one note, and the what's-new block if
 * asked. The auto-update test's newer version is 99.0.0 there, newer than anything these tests prepare, unless a test
 * asks for this repo's own file (`fixture: "real"`).
 */
async function copy(o: { block?: string | null; fixture?: "real" } = {}): Promise<string> {
  const dir = await tmp("prepare-release-");
  for (const f of FILES) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await cp(join(root, f), join(dir, f));
  }
  const file = join(dir, "CHANGELOG.md");
  const log = (await readFile(file, "utf8")).replace(/^## Unreleased\n/m, "## 0.0.0: what this repo had under Unreleased\n");
  const first = log.search(/^## /m);
  if (o.fixture !== "real") await writeFile(join(dir, "test/autoupdate.test.ts"), fixtureAt("99.0.0"));
  await writeFile(file, `${log.slice(0, first)}## Unreleased\n\n${o.block ? `${o.block}\n\n` : ""}- **A note for the test.** What a user would notice. (COMPAT-1)\n\n${log.slice(first)}`);
  return dir;
}
const read = (dir: string, f: string) => readFile(join(dir, f), "utf8");
const all = async (dir: string) => Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await read(dir, f)])));
const run = (dir: string, ...args: string[]) => exec(process.execPath, [script, ...args, "--root", dir], { timeoutMs: 60000 });
const versions = async (dir: string) => {
  const lock = JSON.parse(await read(dir, "package-lock.json"));
  return [JSON.parse(await read(dir, "package.json")).version, lock.version, lock.packages[""].version, JSON.parse(await read(dir, ".claude-plugin/plugin.json")).version];
};
const pinned = (text: string) => [...new Set([...text.matchAll(/releases\/download\/v([^/]+)\//g)].map((m) => m[1]))];

describe.skipIf(!existsSync(script))("scripts/prepare-release.mjs", () => {
  it("a test build changes the version in three files and nothing else", async () => {
    const dir = await copy();
    const before = await all(dir);
    const r = await run(dir, `${V}-next.1`);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(await versions(dir)).toEqual(Array(4).fill(`${V}-next.1`));
    const after = await all(dir);
    expect(FILES.filter((f) => after[f] !== before[f])).toEqual(["package.json", "package-lock.json", ".claude-plugin/plugin.json"]);
    // Not a release: the CHANGELOG keeps "Unreleased", what's-new has no entry for it, and the guides pin the same release.
    expect(after["CHANGELOG.md"]).toMatch(/^## Unreleased$/m);
    expect(after["src/core/whats-new.ts"]).not.toContain(V);
    expect(pinned(after["INSTALL.md"])).toEqual(pinned(before["INSTALL.md"]));
    // It says what it did and what comes next, and that the bump needn't be committed.
    expect(r.stdout).toContain(`Prepared the test build ${V}-next.1.`);
    expect(r.stdout).toContain("git restore package.json package-lock.json .claude-plugin/plugin.json");
    expect(r.stdout).toMatch(new RegExp(`tag v${V.replace(/\./g, "\\.")}-next\\.1 in the public clone, push the tag only`));
    expect((await readdir(dir)).includes(".git")).toBe(false);

    // The next test build, then one that would go back.
    expect((await run(dir, `${V}-next.2`)).code).toBe(0);
    expect(await versions(dir)).toEqual(Array(4).fill(`${V}-next.2`));
    const back = await run(dir, `${V}-next.1`);
    expect(back.code).toBe(1);
    expect(back.stderr).toContain(`${V}-next.1 isn't newer than ${V}-next.2, the version package.json has now.`);
  });

  it("a release does every edit: versions, the pinned release, the CHANGELOG heading, a what's-new entry, and the test's newer version", async () => {
    const dir = await copy({ block: BLOCK, fixture: "real" });
    const before = await all(dir);
    const was = pinned(before["INSTALL.md"])[0]!;
    // From a test build of it, as on release day: the guides still pin the last release, whatever package.json says.
    // That test build is also where the auto-update test's version stopped being newer, so it moved then.
    const build = await run(dir, `${V}-next.3`);
    expect(build.code).toBe(0);
    expect(build.stdout).toMatch(/test\/autoupdate\.test\.ts: the newer team package it installs, \d+\.\d+\.\d+ → 98\.1\.0/);
    expect(build.stdout).toContain("git restore package.json package-lock.json .claude-plugin/plugin.json test/autoupdate.test.ts");
    const r = await run(dir, V, "One command to update a team", "--date", "2026-12-04");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(await versions(dir)).toEqual(Array(4).fill(V));
    const after = await all(dir);

    // Only the version moved in the JSON files.
    const lockBefore = JSON.parse(before["package-lock.json"]), lockAfter = JSON.parse(after["package-lock.json"]);
    lockBefore.version = lockBefore.packages[""].version = V;
    expect(lockAfter).toEqual(lockBefore);
    expect({ ...JSON.parse(after["package.json"]), version: 0 }).toEqual({ ...JSON.parse(before["package.json"]), version: 0 });

    // INSTALL.md and README.md pin this release everywhere they pinned the last one, and nothing else in them changed.
    for (const f of ["INSTALL.md", "README.md"]) {
      expect(pinned(after[f])).toEqual([V]);
      expect(after[f]).toContain(`releases/download/v${V}/productmaxxing-${V}.tgz`);
      expect(after[f].split(V).join(was)).toBe(before[f]);
    }
    expect(after["INSTALL.md"]).toContain(`releases/download/v${V}/SHA256SUMS`);
    expect(after["INSTALL.md"]).toContain(`[v${V} release](https://github.com/kp-prodgit/productmaxxing/releases/tag/v${V})`);
    expect(after["INSTALL.md"]).not.toContain(was);

    // "Unreleased" is this release now, its notes kept, and the what's-new block is gone from the CHANGELOG.
    expect(after["CHANGELOG.md"]).toContain(`## ${V}: One command to update a team\n\n- **A note for the test.** What a user would notice. (COMPAT-1)\n`);
    expect(after["CHANGELOG.md"]).not.toMatch(/^## Unreleased$/m);
    expect(after["CHANGELOG.md"]).not.toContain("<!-- whats-new");
    expect(after["CHANGELOG.md"].length).toBe(before["CHANGELOG.md"].length - "## Unreleased".length + `## ${V}: One command to update a team`.length - BLOCK.length - 2);

    // What's new starts with it, made from the block: each item, with the command to try where one was given.
    const notes = after["src/core/whats-new.ts"];
    const entry = [
      "export const RELEASE_NOTES: ReleaseNote[] = [",
      "  {",
      `    version: "${V}", date: "2026-12-04", headline: "One command to update a team",`,
      "    items: [",
      '      { what: "One command moves a team to the newest release.", try: "pmx vendor --latest" },',
      '      { what: "Setup asks only what PMX can\'t work out: \\"two questions\\", not twenty, and costs $$0 & nothing ($&)." },',
      "    ],",
      "  },",
      "  {",
    ].join("\n");
    expect(notes).toContain(entry);
    expect(notes.replace(entry, () => "export const RELEASE_NOTES: ReleaseNote[] = [\n  {")).toBe(before["src/core/whats-new.ts"]);
    expect(ts.transpileModule(notes, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } }).diagnostics).toEqual([]);

    // The team package the auto-update tests install was newer than the old version; it's newer than this one too.
    expect(after["test/autoupdate.test.ts"]).toContain('\nconst NEWER = "98.1.0";\n');
    expect(after["test/autoupdate.test.ts"].replace('const NEWER = "98.1.0";', "")).toBe(before["test/autoupdate.test.ts"].replace(/const NEWER = "\d+\.\d+\.\d+";/, ""));

    expect(r.stdout).toContain(`Prepared the release ${V}: One command to update a team.`);
    expect(r.stdout).toContain(`git commit -m "Release ${V}: One command to update a team"`);
    expect(r.stdout).toContain("git add package.json package-lock.json .claude-plugin/plugin.json INSTALL.md README.md CHANGELOG.md src/core/whats-new.ts\n");

    // Released: neither it nor a test build of it can be prepared again.
    for (const again of [[V, "The same release again"], [`${V}-next.4`]]) {
      const no = await run(dir, ...again);
      expect(no.code).toBe(1);
      expect(no.stderr).toMatch(/isn't newer than 98\.0\.0, the version package\.json has now/);
    }
    expect(await all(dir)).toEqual(after);
  });

  it("takes the what's-new block from anywhere under Unreleased, and leaves one blank line where it was", async () => {
    const note = "- **A note for the test.** What a user would notice. (COMPAT-1)\n";
    for (const [written, left] of [
      // Between two notes with blank lines around it, with more blank lines than one, and in a tight list.
      [`${note}\n${BLOCK}\n\n- **A second note.** More.\n`, `${note}\n- **A second note.** More.\n`],
      [`${note}\n\n${BLOCK}\n\n\n- **A second note.** More.\n`, `${note}\n- **A second note.** More.\n`],
      [`${note}${BLOCK}\n- **A second note.** More.\n`, `${note}- **A second note.** More.\n`],
      // Last in the section: one blank line before the next heading.
      [`${note}\n${BLOCK}\n`, note],
    ] as const) {
      const dir = await copy();
      const before = await read(dir, "CHANGELOG.md");
      expect(before).toContain(`## Unreleased\n\n${note}\n## `);
      await writeFile(join(dir, "CHANGELOG.md"), before.replace(note, () => written)); // a function: the block has a "$&" in it
      const r = await run(dir, V, "A block lower down", "--date", "2026-12-04");
      expect([written, r.code, r.stderr]).toEqual([written, 0, ""]);
      expect(await read(dir, "CHANGELOG.md")).toBe(before.replace(`## Unreleased\n\n${note}`, () => `## ${V}: A block lower down\n\n${left}`));
      expect(await read(dir, "src/core/whats-new.ts")).toContain('{ what: "One command moves a team to the newest release.", try: "pmx vendor --latest" },');
    }
  });

  it("leaves the test's newer version alone while it is still newer", async () => {
    const dir = await copy({ block: BLOCK });
    const fixture = fixtureAt("98.0.0");
    await writeFile(join(dir, "test/autoupdate.test.ts"), fixture);
    // 98.0.0 is newer than its own test build.
    expect((await run(dir, "98.0.0-next.1")).code).toBe(0);
    expect(await read(dir, "test/autoupdate.test.ts")).toBe(fixture);
    const r = await run(dir, "98.0.0", "The release the test version named");
    expect(r.code).toBe(0);
    expect(await read(dir, "test/autoupdate.test.ts")).toBe(fixture.split("98.0.0").join("98.1.0"));
    expect(r.stdout).toContain("test/autoupdate.test.ts: the newer team package it installs, 98.0.0 → 98.1.0");
  });

  it("refuses a release with no what's-new block, and says how to write one; an empty or garbled block too", async () => {
    for (const [block, said] of [
      [null, /CHANGELOG\.md has no what's-new block under "## Unreleased", and this script doesn't invent one\.[\s\S]*<!-- whats-new\n- What changed/],
      ["<!-- whats-new\n-->", /The what's-new block under "## Unreleased" is empty/],
      ["<!-- whats-new\n  try: pmx doctor\n-->", /a "try:" line with no item before it/],
      ["<!-- whats-new\n- An item.\nSome other words.\n-->", /neither "- an item" nor "try: a command": "Some other words\."/],
    ] as const) {
      const dir = await copy({ block });
      const before = await all(dir);
      const r = await run(dir, V, "A release with nothing to say");
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(said);
      expect(r.stdout).toBe("");
      expect(await all(dir)).toEqual(before);
    }
    // A block in an older release's section doesn't count: it has to be under "Unreleased".
    const dir = await copy();
    await writeFile(join(dir, "CHANGELOG.md"), `${await read(dir, "CHANGELOG.md")}\n${BLOCK}\n`);
    expect((await run(dir, V, "A release with nothing to say")).stderr).toContain("has no what's-new block");
  });

  it("changes nothing when a check fails or the request makes no sense", async () => {
    const refused = async (change: (dir: string) => Promise<void>, args: string[], said: RegExp) => {
      const dir = await copy({ block: BLOCK });
      await change(dir);
      const before = await all(dir);
      const r = await run(dir, ...args);
      expect([args, r.code]).toEqual([args, 1]);
      expect(r.stderr).toMatch(said);
      expect(await all(dir)).toEqual(before);
    };
    const nothing = async () => {};
    const edit = (f: string, change: (s: string) => string) => async (dir: string) => writeFile(join(dir, f), change(await read(dir, f)));

    await refused(nothing, [], /usage: node scripts\/prepare-release\.mjs/);
    await refused(nothing, ["98.0"], /"98\.0" isn't a version: a release is X\.Y\.Z, a test build X\.Y\.Z-next\.N/);
    await refused(nothing, ["98.0.0-rc.1"], /isn't a version/);
    // A number written with a leading zero would pass every test and fail only at npm publish, so it stops here.
    await refused(nothing, ["98.0.0-next.01"], /^"98\.0\.0-next\.01" has a number written with a leading zero, which npm refuses as a version\. Write 98\.0\.0-next\.1\.\n$/);
    await refused(nothing, ["98.0.0-next.00"], /leading zero.*Write 98\.0\.0-next\.0\./);
    await refused(nothing, ["98.00.0", "A fine title"], /"98\.00\.0" has a number written with a leading zero.*Write 98\.0\.0\./);
    await refused(nothing, ["098.0.0", "A fine title"], /leading zero.*Write 98\.0\.0\./);
    await refused(nothing, ["98.0.01-next.1"], /leading zero.*Write 98\.0\.1-next\.1\./);
    await refused(nothing, [V], /A release needs its title/);
    await refused(nothing, [`${V}-next.1`, "A title"], /A test build has no title/);
    await refused(nothing, ["0.12.0", "An old release"], /0\.12\.0 isn't newer than .*the version package\.json has now/);
    await refused(nothing, [V, "A fine title", "--publish"], /Unknown option --publish/);
    await refused(nothing, [V, "A fine title", "--date", "4 December"], /--date takes YYYY-MM-DD/);
    // A release whose number is behind an upgrade step's would mislabel the step.
    await refused(edit("src/core/upgrade.ts", (s) => `${s}\n// since: "99.0.0"\n`), [V, "A fine title"], /an upgrade step since 99\.0\.0, which is after 98\.0\.0/);
    await refused(edit("src/core/upgrade.ts", (s) => `${s}\n// since: "99.0.0"\n`), [`${V}-next.1`], /an upgrade step since 99\.0\.0/);
    // Nothing under "Unreleased": no notes to release, and nothing a test build would be testing.
    const noNotes = edit("CHANGELOG.md", (s) => s.replace("- **A note for the test.** What a user would notice. (COMPAT-1)\n", ""));
    await refused(noNotes, [V, "A fine title"], /Nothing was changed\. A check failed:\n  - CHANGELOG\.md has no notes under "## 98\.0\.0: A fine title"/);
    await refused(noNotes, [`${V}-next.1`], /Nothing was changed\. A check failed:\n  - CHANGELOG\.md has no notes under "## Unreleased": say what this test build is testing/);
    await refused(edit("CHANGELOG.md", (s) => s.replace("## Unreleased\n", "## Not yet\n")), [V, "A fine title"], /CHANGELOG\.md has no "## Unreleased" heading/);
    // A pin the script doesn't know how to move: caught by the check on the result, after every edit was worked out.
    await refused(async (dir) => {
      const guide = await read(dir, "INSTALL.md");
      await writeFile(join(dir, "INSTALL.md"), `${guide}\nThe newest pmx is ${pinned(guide)[0]}.\n`);
    }, [V, "A fine title"], /Nothing was changed\. A check failed:\n  - INSTALL\.md would still name \d+\.\d+\.\d+ on line \d+/);
    // A lockfile that disagrees with package.json.
    await refused(edit("package-lock.json", (s) => s.replace(/"version": "[^"]+"/, '"version": "0.0.1"')), [`${V}-next.1`], /package-lock\.json doesn't say "version": ".*" where it should \(found 1 of 2\)/);
  });

  it("stays in the source repo with RELEASING.md: the export publishes neither", async () => {
    const exporter = await readFile(join(root, "scripts/export-public.sh"), "utf8");
    const published = exporter.match(/^PUBLIC=\((.*)\)$/m)![1]!.split(" ");
    expect(published).not.toContain("scripts");
    expect(published).not.toContain("RELEASING.md");
    expect(published).toEqual(expect.arrayContaining([".github", "test", "CHANGELOG.md", "INSTALL.md"]));
    expect(existsSync(join(root, "RELEASING.md"))).toBe(true);
  });
});
