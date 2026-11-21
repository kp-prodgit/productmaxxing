import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appSkillSource, appSkillTarget, SETUP_SKILL } from "../src/claude/skill.js";
import { fakeLaunchd, plist } from "../src/core/launchd.js";
import { paths, pmxHome } from "../src/core/paths.js";
import { loadState, updateState } from "../src/core/state.js";
import { AUTO_STEPS, markFreshInstall, upgradeOnStart, type AutoStep } from "../src/core/upgrade.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, tmp } from "./helpers.js";

const noExec = (async () => ({ code: 1, stdout: "", stderr: "" })) as any;
const deps = (o: Partial<Parameters<typeof upgradeOnStart>[0]> = {}) => ({ exec: noExec, launchd: fakeLaunchd(), cliPath: "/x/cli.js", interactive: true, devInstall: async () => false, ...o });
const v = currentVersion();

/** Steps that only count their runs, at the versions a test needs. */
function counting() {
  const ran: string[] = [];
  const mk = (id: string, since: string | null, o: Partial<AutoStep> = {}): AutoStep => ({ id, since, title: id, run: async () => { ran.push(id); return `did ${id}`; }, ...o });
  return { ran, mk };
}

describe("version-aware update steps (UPGRADE-1)", () => {
  // Each test gets its own Claude app folder: other test files install PMX's commands into the shared one.
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("pmx-claude-"); });

  it("runs what applies to the version a Mac came from, once each, and nothing on the next command", async () => {
    await writeFile(paths.config(), "{}");
    // A Mac whose last pmx predates this record: NEW-1 remembers the version it last ran.
    await updateState((s) => { s.whatsNew = { seen: "0.20.0", since: null }; });
    const { ran, mk } = counting();
    const steps = [mk("every", null), mk("since-0.25", "0.25.0"), mk("since-0.10", "0.10.0"), mk("later", "99.0.0")];
    const r = await upgradeOnStart(deps(), steps);
    expect(r.from).toBe("0.20.0");
    // 0.20.0 is before 0.25.0 and 99.0.0, not before 0.10.0.
    expect(ran.sort()).toEqual(["every", "later", "since-0.25"]);
    const rec = (await loadState()).upgrade!;
    expect(rec).toMatchObject({ lastVersion: v, from: "0.20.0" });
    expect(Object.keys(rec.applied).sort()).toEqual([`every@${v}`, "later", "since-0.25"]);
    ran.length = 0;
    expect((await upgradeOnStart(deps(), steps)).did).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("treats a set-up Mac with no record of its version as old; a Mac never set up, or a fresh install, as current", async () => {
    const { ran, mk } = counting();
    const steps = [mk("every", null), mk("since-0.25", "0.25.0"), mk("next", "99.0.0")];
    // Never set up: no settings, no record. Nothing to upgrade.
    expect(await upgradeOnStart(deps(), steps)).toMatchObject({ from: v, did: [] });
    expect(ran).toEqual([]);

    await freshHome();
    await writeFile(paths.config(), "{}");
    await upgradeOnStart(deps(), steps);
    expect(ran.sort()).toEqual(["every", "next", "since-0.25"]);

    await freshHome();
    await markFreshInstall(new Date(), steps);
    ran.length = 0;
    expect((await upgradeOnStart(deps(), steps)).did).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("leaves a job reload to a command someone runs, and retries a step that failed", async () => {
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.whatsNew = { seen: "0.20.0", since: null }; });
    let fail = true;
    const { ran, mk } = counting();
    const steps = [mk("job", null, { interactiveOnly: true }), mk("flaky", null, { run: async () => { if (fail) throw new Error("not now"); ran.push("flaky"); return "ok"; } })];
    const bg = await upgradeOnStart(deps({ interactive: false }), steps);
    expect(bg.waiting.map((w) => [w.id, w.why])).toEqual([["job", "waits for the next pmx command you run"], ["flaky", "not now"]]);
    expect(ran).toEqual([]);
    fail = false;
    const fg = await upgradeOnStart(deps(), steps);
    expect(fg.did.map((d) => d.id)).toEqual(["job", "flaky"]);
    // The starting point stays the version this Mac came from.
    expect(fg.from).toBe("0.20.0");
  });

  it("refreshes PMX's commands in the Claude app and adds /pmx-setup where PMX installed /pmx-schedule", async () => {
    await mkdir(join(appSkillTarget(), ".."), { recursive: true });
    await writeFile(appSkillTarget(), "---\nname: pmx-schedule\n---\n<!-- Installed by ProductMaxxing -->\nold");
    const skills = AUTO_STEPS.find((s) => s.id === "app-skills")!;
    expect(await skills.run(deps())).toBe(`updated /pmx-schedule, /${SETUP_SKILL} (new)`);
    expect(await readFile(appSkillTarget(), "utf8")).toBe(await readFile(appSkillSource(), "utf8"));
    expect(await readFile(appSkillTarget(SETUP_SKILL), "utf8")).toBe(await readFile(appSkillSource(SETUP_SKILL), "utf8"));
    expect(await skills.run(deps())).toBeNull();
  });

  it("points the Claude app's PMX server at this pmx, but never from a source checkout", async () => {
    const file = process.env.PMX_CLAUDE_DESKTOP_CONFIG!;
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { pmx: { command: "/old/node", args: ["/old/cli.js", "mcp"] }, other: { command: "x" } } }));
    const mcp = AUTO_STEPS.find((s) => s.id === "mcp-entry")!;
    expect(await mcp.run(deps({ devInstall: async () => true }))).toBeNull();
    expect(await mcp.run(deps())).toBe("pointed the Claude app's PMX server at this pmx");
    const cfg = JSON.parse(await readFile(file, "utf8"));
    expect(cfg.mcpServers.pmx.args).toEqual(["/x/cli.js", "mcp"]);
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
  });

  it("rewrites a stale background job for this PMX home only, and never under a running pass", async () => {
    const job = mkJob();
    const cli0 = join(await tmp("pmx-cli-"), "cli.js");
    await writeFile(cli0, "");
    const cli = realpathSync(cli0);
    await job.install(plist({ node: "/gone/node", cli: "/gone/cli.js", pmxHome: pmxHome(), claude: null }));
    const step = AUTO_STEPS.find((s) => s.id === "background-job")!;
    job.busy = true;
    await expect(step.run(deps({ launchd: job, cliPath: cli }))).rejects.toThrow(/running a pass/);
    job.busy = false;
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBe("refreshed the background job with this pmx, Node and Claude Code");
    expect(job.plist).toContain(`<string>${cli}</string>`);
    expect(job.plist).not.toContain("/gone/");
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBeNull();

    // A job another PMX home registered (a second install on this Mac) is left as it is.
    await job.install(plist({ node: "/gone/node", cli: "/gone/cli.js", pmxHome: "/elsewhere/.pmx", claude: null }));
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBeNull();
    expect(job.plist).toContain("/gone/cli.js");
  });
});

function mkJob() {
  const f = Object.assign(fakeLaunchd(), { busy: false });
  return Object.assign(f, { running: async () => f.busy });
}
