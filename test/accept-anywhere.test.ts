// REV-4: accepting a local draft doesn't depend on what the PM has checked out or is editing. The draft's own files are
// the only ones that change, the person's edits and staged files stay theirs, and a clash is one plain sentence.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Git } from "../src/core/git.js";
import { localHost } from "../src/core/host.js";
import { freshHome, git, pmxRepo, tmp } from "./helpers.js";

const DRAFT = "pmx/task/PMX-19-spec-scim";

/** A team repo with notes/x.md on main, and a draft for PMX-19 that changes it and adds outputs/spec/PMX-19.md. */
async function repoWithDraft(): Promise<string> {
  const { repo } = await pmxRepo();
  await mkdir(join(repo, "notes"), { recursive: true });
  await writeFile(join(repo, "notes", "x.md"), "line one\nline two\n");
  await writeFile(join(repo, "mine.md"), "my notes\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "notes");
  await git(repo, "checkout", "-q", "-b", DRAFT);
  await writeFile(join(repo, "notes", "x.md"), "line one\nline two, drafted\n");
  await mkdir(join(repo, "outputs", "spec"), { recursive: true });
  await writeFile(join(repo, "outputs", "spec", "PMX-19.md"), "# Spec SCIM\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "PMX-19: Spec SCIM");
  await git(repo, "checkout", "-q", "main");
  return repo;
}
const status = (repo: string) => git(repo, "status", "--porcelain", "--untracked-files=all");
const filesIn = async (repo: string, ref: string) => (await git(repo, "show", "--name-only", "--format=", ref)).split("\n").filter(Boolean).sort();
const NO_GIT_WORDS = /branch|checkout|check out|commit|working tree|remote/i;

describe("accepting a local draft (REV-4)", () => {
  beforeEach(freshHome);

  it("a: main checked out with edits elsewhere: only the draft's files change, and the person's staged file isn't swept in", async () => {
    const repo = await repoWithDraft();
    await writeFile(join(repo, "mine.md"), "my notes, edited\n");
    await writeFile(join(repo, "staged.md"), "staged by me\n");
    await git(repo, "add", "staged.md");
    const before = await status(repo);
    await localHost(new Git(repo)).accept(DRAFT);
    expect(await filesIn(repo, "main")).toEqual(["notes/x.md", "outputs/spec/PMX-19.md"]);
    expect(await git(repo, "log", "-1", "--format=%s", "main")).toBe(`Accept ${DRAFT}`);
    expect(await readFile(join(repo, "notes", "x.md"), "utf8")).toBe("line one\nline two, drafted\n");
    expect(await readFile(join(repo, "outputs", "spec", "PMX-19.md"), "utf8")).toBe("# Spec SCIM\n");
    // The person's own work is exactly as it was: still edited, still staged, and nothing else shows as changed.
    expect(await status(repo)).toBe(before);
    expect(await readFile(join(repo, "mine.md"), "utf8")).toBe("my notes, edited\n");
    expect(await git(repo, "branch", "--list", DRAFT)).toBe("");
  });

  it("b: an unsaved edit to a file the draft changes: one plain sentence naming it, and nothing changes", async () => {
    const repo = await repoWithDraft();
    await writeFile(join(repo, "notes", "x.md"), "line one\nline two, mine\n");
    const head = await git(repo, "rev-parse", "main");
    const err = await localHost(new Git(repo)).accept(DRAFT).then(() => null, (e: Error) => e.message);
    expect(err).toBe("PMX can't accept PMX-19 yet: you have unsaved edits to notes/x.md, which this draft also changes. Save or undo them, then accept again.");
    expect(err).not.toMatch(NO_GIT_WORDS);
    expect(await git(repo, "rev-parse", "main")).toBe(head);
    expect(await readFile(join(repo, "notes", "x.md"), "utf8")).toBe("line one\nline two, mine\n");
    expect(await git(repo, "branch", "--list", DRAFT)).not.toBe("");

    // A file of the person's own at a path the draft adds counts too.
    await git(repo, "checkout", "-q", "--", "notes/x.md");
    await mkdir(join(repo, "outputs", "spec"), { recursive: true });
    await writeFile(join(repo, "outputs", "spec", "PMX-19.md"), "my own copy\n");
    expect(await localHost(new Git(repo)).accept(DRAFT).then(() => null, (e: Error) => e.message)).toBe("PMX can't accept PMX-19 yet: you have unsaved edits to outputs/spec/PMX-19.md, which this draft also changes. Save or undo them, then accept again.");
  });

  it("c: another branch checked out: the draft lands on main and the files on disk don't change", async () => {
    const repo = await repoWithDraft();
    await git(repo, "checkout", "-q", "-b", "my-idea");
    await writeFile(join(repo, "notes", "x.md"), "line one\nline two, my idea\n");
    const before = await status(repo);
    await localHost(new Git(repo)).accept(DRAFT);
    expect(await filesIn(repo, "main")).toEqual(["notes/x.md", "outputs/spec/PMX-19.md"]);
    expect(await git(repo, "show", "main:notes/x.md")).toBe("line one\nline two, drafted");
    expect(await git(repo, "branch", "--show-current")).toBe("my-idea");
    expect(await status(repo)).toBe(before);
    expect(existsSync(join(repo, "outputs", "spec", "PMX-19.md"))).toBe(false);
    expect(await git(repo, "branch", "--list", DRAFT)).toBe("");

    // A detached checkout works the same way.
    await git(repo, "checkout", "-q", "--", "notes/x.md");
    await git(repo, "checkout", "-q", "-b", "pmx/task/PMX-20-x", "main");
    await writeFile(join(repo, "outputs", "spec", "PMX-20.md"), "# Twenty\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "PMX-20");
    await git(repo, "checkout", "-q", "--detach", "main~1");
    await localHost(new Git(repo)).accept("pmx/task/PMX-20-x");
    expect(await filesIn(repo, "main")).toEqual(["outputs/spec/PMX-20.md"]);
  });

  it("c: main checked out in another folder: the draft's files change there, and an unsaved edit there stops it", async () => {
    const repo = await repoWithDraft();
    await git(repo, "checkout", "-q", "-b", "my-idea");
    const other = join(await tmp("pmx-other-"), "main");
    await git(repo, "worktree", "add", "-q", other, "main");
    await writeFile(join(other, "notes", "x.md"), "edited over there\n");
    expect(await localHost(new Git(repo)).accept(DRAFT).then(() => null, (e: Error) => e.message)).toMatch(/^PMX can't accept PMX-19 yet: you have unsaved edits to notes\/x\.md/);
    await git(other, "checkout", "-q", "--", "notes/x.md");
    await localHost(new Git(repo)).accept(DRAFT);
    expect(await readFile(join(other, "outputs", "spec", "PMX-19.md"), "utf8")).toBe("# Spec SCIM\n");
    expect(await status(other)).toBe("");
  });

  it("a draft that clashes with what changed since: one plain sentence, and nothing changes", async () => {
    const repo = await repoWithDraft();
    await writeFile(join(repo, "notes", "x.md"), "line one\nline two, changed on main\n");
    await git(repo, "commit", "-q", "-am", "someone else");
    const head = await git(repo, "rev-parse", "main");
    const err = await localHost(new Git(repo)).accept(DRAFT).then(() => null, (e: Error) => e.message);
    expect(err).toBe("PMX can't accept PMX-19: it changes part of a file that has also changed since it was drafted. Ask for a redo, and the agent drafts it again from the latest.");
    expect(err).not.toMatch(NO_GIT_WORDS);
    expect(await git(repo, "rev-parse", "main")).toBe(head);
    expect(await status(repo)).toBe("");
  });

  it("team settings without a remote apply the same way, with words for settings", async () => {
    const repo = await repoWithDraft();
    await git(repo, "checkout", "-q", "-b", "pmx/settings-20261121120000");
    await writeFile(join(repo, "mine.md"), "settings change\n");
    await git(repo, "commit", "-q", "-am", "settings");
    await git(repo, "checkout", "-q", "main");
    await writeFile(join(repo, "mine.md"), "my own edit\n");
    expect(await localHost(new Git(repo)).accept("pmx/settings-20261121120000").then(() => null, (e: Error) => e.message)).toBe("PMX can't apply your team's settings yet: you have unsaved edits to mine.md, which these settings also change. Save or undo them, then apply again.");
  });
});
