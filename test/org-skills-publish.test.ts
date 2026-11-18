import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { enqueueSkillDoc, overlay, readOutbox, relayPrompt, type Snapshot } from "../src/tracker/relay.js";
import { teamSkillPath } from "../src/core/skills.js";
import { paths } from "../src/core/paths.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const linearTeam = (): TeamConfig => ({ ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "pmx-1" } }) as TeamConfig;
const docSkill = (name: string) =>
  `---\nname: ${name}\ndescription: ${name} is a document skill for tests, long enough to pass.\npmx: ${JSON.stringify({ kind: "category", category: name, stage: "identify", output: `outputs/${name}/{id}.md`, env: { kind: "document" } })}\n---\n# ${name}\n\n## Summary\n\nx\n`;
async function writeRepoSkill(repo: string, name: string, text: string): Promise<void> {
  const p = teamSkillPath(repo, name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text);
}
const skillsCmd = commands.find((c) => c.name === "skills")!;
const run = (ctx: unknown, positionals: string[]) => skillsCmd.run({ values: {}, positionals, ask: {} as never, ctx: async () => ctx, cliPath: "" } as never);

describe("publishing org skills through Linear (JOB, Slice 2b)", () => {
  beforeEach(freshHome);

  it("enqueueSkillDoc queues one upsert-skill-doc op", async () => {
    await enqueueSkillDoc("ux-audit", docSkill("ux-audit"));
    const ob = await readOutbox();
    expect(ob.ops).toHaveLength(1);
    expect(ob.ops[0]).toMatchObject({ kind: "upsert-skill-doc", name: "ux-audit" });
    expect(ob.ops[0]!.id).toBeTruthy();
  });

  it("overlay ignores a skill-doc op (it's a Linear document, not an issue)", () => {
    const snap: Snapshot = { v: 1, syncedAt: "", projectId: "pmx-1", issues: [] };
    expect(overlay(snap, [{ id: "a", at: "", kind: "upsert-skill-doc", name: "x", body: "y" }])).toEqual([]);
  });

  it("the sync-task prompt exports skill docs and explains upsert-skill-doc when one is queued", async () => {
    await enqueueSkillDoc("ux-audit", docSkill("ux-audit"));
    const prompt = await relayPrompt(linearTeam());
    expect(prompt).toContain("upsert-skill-doc");
    expect(prompt).toContain("pmx-skill:");
    expect(prompt).toContain(paths.orgSkillsExport());
  });

  it("`pmx skills publish` queues a valid document skill in relay mode", async () => {
    const { repo } = await pmxRepo();
    await writeRepoSkill(repo, "ux-audit", docSkill("ux-audit"));
    const ctx = await testCtx({ repo, team: { tracker: { kind: "linear", teamKey: "PMX", projectId: "pmx-1" } } });
    expect(await run(ctx, ["publish", "ux-audit"])).toBe(0);
    const ob = await readOutbox();
    expect(ob.ops.map((o) => o.kind)).toContain("upsert-skill-doc");
  });

  it("`pmx skills publish` refuses a non-document skill and a missing one", async () => {
    const { repo } = await pmxRepo();
    await writeRepoSkill(repo, "proto", `---\nname: proto\ndescription: a tool-widening skill for tests, long enough.\npmx: ${JSON.stringify({ kind: "category", category: "proto", env: { kind: "prototype", tools: ["Read", "Bash"] } })}\n---\n# proto\n`);
    const ctx = await testCtx({ repo, team: { tracker: { kind: "linear", teamKey: "PMX", projectId: "pmx-1" } } });
    await expect(run(ctx, ["publish", "proto"])).rejects.toThrow(/Can't publish/);
    await expect(run(ctx, ["publish", "nope"])).rejects.toThrow(/No skill at/);
  });
});
