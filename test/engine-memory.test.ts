// Bridge 3 of the join with PMX Engine (EQ-37): the PMs' page arrives in the team repo's memory/engine/ through a
// reviewed pull request. Agents find it through CLAUDE.md; a task for the tracker never repeats it word for word.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { services } from "../src/core/services.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { parseCandidates, releasedStrategy, synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const VISION = "# Vision\n\n## Company\n\n### Where we are going\n\nAcme makes Fieldbook, software for planning and recording work on infrastructure. By the end of FY28, every crew that opens a road plans the job in Fieldbook first.\n";

async function withStrategy(repo: string): Promise<void> {
  await mkdir(join(repo, "memory", "engine"), { recursive: true });
  await writeFile(join(repo, "memory", "engine", "README.md"), "# Released strategy from PMX Engine\n\nThese files are what the product managers' page shows.\n");
  await writeFile(join(repo, "memory", "engine", "vision.md"), VISION);
}

describe("released strategy in team memory (EQ-37, bridge 3 of the join)", () => {
  beforeEach(freshHome);

  it("reads memory/engine's Markdown files but not its README, and nothing when there are none", async () => {
    const { repo } = await pmxRepo();
    expect(await releasedStrategy(repo)).toEqual([]);
    await withStrategy(repo);
    await writeFile(join(repo, "memory", "engine", "notes.txt"), "not Markdown");
    expect(await releasedStrategy(repo)).toEqual([VISION]);
  });

  it("skips a task that repeats the released strategy word for word; one that builds on it is fine", () => {
    const reply = JSON.stringify({ tasks: [
      { title: "Plan-first crews", category: "spec", size: "M", rationale: "Make sure every crew that opens a road plans the job in Fieldbook first.", sources: ["T1"], support: { T1: "The customer plans jobs in spreadsheets." } },
      { title: "Offline job plans", category: "spec", size: "M", rationale: "Crews plan where there is no signal; this fits where the product is going.", sources: ["T1"], support: { T1: "The customer plans jobs in spreadsheets." } },
    ] });
    const r = parseCandidates(reply, ["spec"], new Set(["T1"]), undefined, new Map(), [VISION]);
    expect(r.tasks.map((t) => t.title)).toEqual(["Offline job plans"]);
    expect(r.skipped).toEqual(["Plan-first crews: its text repeats your team's released strategy word for word, and the tracker gets summaries only"]);
    expect(parseCandidates(reply, ["spec"], new Set(["T1"])).tasks).toHaveLength(2);
  });

  it("synthesis guards the strategy in the team's repo, so it never reaches the tracker", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    await withStrategy(repo);
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Our crews plan every dig in a spreadsheet, then retype it.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [
      { title: "Plan-first crews", category: "spec", size: "M", rationale: "So that every crew that opens a road plans the job in Fieldbook first.", sources: ["T1"], support: { T1: "The customer plans digs by hand." } },
      { title: "Import dig plans from spreadsheets", category: "spec", size: "S", rationale: "Crews retype plans; an import saves the step.", sources: ["T1"], support: { T1: "The customer plans digs by hand." } },
    ] }));
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const r = await synthesize(ctx, await services(ctx, { tracker: memoryTracker([]) }), { days: 7 });
    expect(r.staged.map((p) => p.title)).toEqual(["Import dig plans from spreadsheets"]);
    expect(r.skipped).toContain("Plan-first crews: its text repeats your team's released strategy word for word, and the tracker gets summaries only");
  });

  it("new repos point agents at it, and pmx doctor says when an older repo's CLAUDE.md doesn't", async () => {
    expect(await readFile(join(root, "templates", "pmx-repo", "CLAUDE.md"), "utf8")).toMatch(/^@memory\/engine\/README\.md$/m);
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const doctor = async () => (await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec, engine: async () => [] })).find((c) => c.id === "repo.memory-engine");
    expect(await doctor()).toBeUndefined();

    await withStrategy(repo);
    expect(await doctor()).toMatchObject({ ok: true, detail: "agents find the released strategy in memory/engine/ through CLAUDE.md" });
    const claude = join(repo, "CLAUDE.md");
    await writeFile(claude, (await readFile(claude, "utf8")).split("\n").filter((l) => !l.includes("memory/engine")).join("\n"));
    expect(await doctor()).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/doesn't point agents at it: add `@memory\/engine\/README\.md`/) });
  });
});
