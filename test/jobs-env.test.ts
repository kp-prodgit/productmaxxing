import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS, materializeOutput, resolveEnv, skillMeta, validateEnv } from "../src/core/skillcheck.js";
import { skillInventory, teamSkillPath } from "../src/core/skills.js";
import { loadTeamConfig } from "../src/core/config.js";
import { jobsCommands } from "../src/commands/jobs.js";
import { pmxRepo, testCtx } from "./helpers.js";

async function writeSkill(repo: string, slug: string, pmx: Record<string, unknown>): Promise<void> {
  const p = teamSkillPath(repo, slug);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `---\nname: ${slug}\ndescription: ${slug} does a thing for tests, long enough.\npmx: ${JSON.stringify(pmx)}\n---\n# ${slug}\n\n## Summary\n\nx\n`);
}

describe("job environment model (JOB-1)", () => {
  it("resolveEnv fills document defaults equal to today's behavior", () => {
    const env = resolveEnv({ kind: "category", category: "spec" }, "spec");
    expect(env.kind).toBe("document");
    expect(env.tools).toEqual([...DEFAULT_TOOLS]);
    expect(env.output).toEqual({ kind: "file", path: "outputs/spec/{id}.md" });
    expect(env.template).toBeNull();
    expect(env.maxTurns).toBeNull();
    expect(materializeOutput(env, "spec", "PRO-12")).toBe("outputs/spec/PRO-12.md");
  });

  it("resolveEnv honors an authored env and materializes custom output", () => {
    const env = resolveEnv(
      { kind: "category", env: { kind: "prototype", tools: ["Read", "Bash"], maxTurns: 60, output: { kind: "repo", path: "prototypes/{id}" } } },
      "proto",
    );
    expect(env.kind).toBe("prototype");
    expect(env.tools).toContain("Bash");
    expect(env.output).toEqual({ kind: "repo", path: "prototypes/{id}" });
    expect(env.maxTurns).toBe(60);
    expect(materializeOutput(env, "proto", "PRO-9")).toBe("prototypes/PRO-9");
  });

  it("validateEnv accepts a plain/absent document env", () => {
    expect(validateEnv(undefined)).toEqual([]);
    expect(validateEnv({ kind: "document", tools: [...DEFAULT_TOOLS], output: { kind: "file", path: "outputs/x/{id}.md" } })).toEqual([]);
    // A non-document job may legitimately widen tools; it's still reserved and fails closed at run time.
    expect(validateEnv({ kind: "prototype", tools: ["Read", "Bash"] })).toEqual([]);
  });

  it("validateEnv rejects widened tools on a document job, unknown tools, bad output/maxTurns/kind and egress", () => {
    expect(validateEnv({ kind: "document", tools: ["Read", "Bash"] }).some((p) => /document.*may not use .*Bash/.test(p))).toBe(true);
    expect(validateEnv({ tools: ["Nope"] }).some((p) => /unknown tools: Nope/.test(p))).toBe(true);
    expect(validateEnv({ tools: [] }).some((p) => /must not be empty/.test(p))).toBe(true);
    expect(validateEnv({ kind: "document", output: { kind: "repo" } }).some((p) => /document.*output\.kind "file"/.test(p))).toBe(true);
    expect(validateEnv({ maxTurns: 0 }).some((p) => /maxTurns/.test(p))).toBe(true);
    expect(validateEnv({ kind: "weird" as never }).some((p) => /env\.kind must be/.test(p))).toBe(true);
    expect(validateEnv({ egress: ["evil.example.com"] } as never).some((p) => /egress/.test(p))).toBe(true);
  });

  it("skillInventory surfaces each skill's resolved env and its problems", async () => {
    const { repo } = await pmxRepo();
    await writeSkill(repo, "good-job", { kind: "category", category: "good-job", stage: "identify", output: "outputs/good-job/{id}.md", env: { kind: "document" } });
    await writeSkill(repo, "bad-job", { kind: "category", category: "bad-job", stage: "identify", output: "outputs/bad-job/{id}.md", env: { kind: "document", tools: ["Read", "Bash"] } });
    const inv = await skillInventory(repo, { "good-job": { skill: "good-job" }, "bad-job": { skill: "bad-job" } });
    const good = inv.find((s) => s.name === "good-job")!;
    expect(good.env.kind).toBe("document");
    expect(good.envProblems).toEqual([]);
    const bad = inv.find((s) => s.name === "bad-job")!;
    expect(bad.envProblems.length).toBeGreaterThan(0);
  });
});

describe("pmx jobs command", () => {
  const cmd = jobsCommands.find((c) => c.name === "jobs")!;
  const args = (positionals: string[], values: Record<string, unknown> = {}) =>
    ({ values, positionals, ask: {} as never, ctx: undefined as never, cliPath: "" });

  it("`jobs new` scaffolds a document job and patches the config, keeping the defaults", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const code = await cmd.run({ ...args(["new", "prototype-creation"]), ctx: async () => ctx } as never);
    expect(code).toBe(0);

    const skill = await readFile(teamSkillPath(repo, "prototype-creation"), "utf8");
    expect(skill).toMatch(/^name: prototype-creation$/m);
    const env = skillMeta(skill).env!;
    expect(env.kind).toBe("document");
    expect(env.output!.path).toBe("outputs/prototype-creation/{id}.md");

    const team = await loadTeamConfig(repo);
    expect(team.categories["prototype-creation"]?.skill).toBe("prototype-creation");
    expect(team.categories["spec"]?.skill).toBe("pmx-spec"); // defaults preserved
  });

  it("`jobs new` refuses bad slugs, the pmx- prefix, and duplicates", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const run = (p: string[]) => cmd.run({ ...args(p), ctx: async () => ctx } as never);
    await expect(run(["new", "Bad Slug"])).rejects.toThrow(/kebab-case/);
    await expect(run(["new", "pmx-foo"])).rejects.toThrow(/reserved/);
    await expect(run(["new", "spec"])).rejects.toThrow(/already a job/); // spec is a default category
  });

  it("`jobs list` shows each job's environment", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      expect(await cmd.run({ ...args([]), ctx: async () => ctx } as never)).toBe(0);
    } finally {
      console.log = orig;
    }
    const text = logs.join("\n");
    expect(text).toMatch(/env: document/);
    expect(text).toMatch(/spec/);
  });
});
