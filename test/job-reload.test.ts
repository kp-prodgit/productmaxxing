// UPGRADE-1 (0.41.0): the background job refreshes itself. A pass can't reload its own job (launchd would stop the pass
// before it could load the job again), so the pass asks for the reload once it has ended. `launchctl` here is a stand-in
// script in a temp folder and the job file is a temp file: nothing touches the real launchd or ~/Library.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { exec } from "../src/core/exec.js";
import { fakeLaunchd, plist, reloadCommand, RELOAD_SCRIPT, stableNode } from "../src/core/launchd.js";
import { paths, pmxHome } from "../src/core/paths.js";
import { loadState, updateState } from "../src/core/state.js";
import { AUTO_STEPS, JOB_RELOADS, JOB_RELOAD_TRIES, StepWaits, upgradeOnStart } from "../src/core/upgrade.js";
import { buildChecklist, formatChecklist, leftLine } from "../src/setup/checklist.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, tmp } from "./helpers.js";

const exists = (f: string) => stat(f).then(() => true, () => false);
const v = currentVersion();

/** A `launchctl` that logs each call, says the job is running while `running` exists, and can refuse a job file. */
async function fakeLaunchctl(o: { refuse?: string } = {}) {
  const dir = await tmp("fake-launchctl-");
  const ctl = join(dir, "launchctl");
  await writeFile(ctl, `#!/bin/sh
echo "$@" >> "${dir}/log"
case "$1" in
  print) if [ -f "${dir}/running" ]; then s=$(cat "${dir}/running"); echo "	state = \${s:-running}"; else echo "	state = not running"; fi ;;
  bootstrap) ${o.refuse ? `if grep -q "${o.refuse}" "$3"; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi` : ":"} ;;
esac
exit 0
`);
  await chmod(ctl, 0o755);
  const dest = join(dir, "job.plist"), pending = join(dir, "pending.plist"), log = join(dir, "tick.log");
  return {
    dir, ctl, dest, pending, log,
    plan: (pid: number) => ({ pid, domain: "gui/501", label: "com.example.job", pending, dest, log, launchctl: ctl }),
    calls: async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

const deps = (o: Partial<Parameters<typeof upgradeOnStart>[0]> = {}) => ({ exec: (async () => ({ code: 1, stdout: "", stderr: "" })) as any, launchd: fakeLaunchd(), cliPath: "/x/cli.js", interactive: false, devInstall: async () => false, pid: 4242, ...o });
const jobStep = AUTO_STEPS.find((s) => s.id === "background-job")!;

describe("the reload a pass asks for, once it has ended (UPGRADE-1)", () => {
  it("waits for the pass and for the job to be idle, then puts the new job file in place and reloads it", async () => {
    const f = await fakeLaunchctl();
    await writeFile(f.dest, "OLD");
    await writeFile(f.pending, "NEW");
    await writeFile(join(f.dir, "running"), "");
    // The pass that asked: a process that's still going.
    const pass = spawn("sleep", ["30"]);
    const { cmd, args } = reloadCommand(f.plan(pass.pid!));
    expect(cmd).toBe("/bin/sh");
    expect(args.slice(0, 2)).toEqual(["-c", RELOAD_SCRIPT]);
    const done = exec(cmd, args, { timeoutMs: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    // Nothing has changed while the pass runs: no reload, the old file, the new one still waiting.
    expect(await readFile(f.dest, "utf8")).toBe("OLD");
    expect((await f.calls()).filter((c) => /^boot/.test(c))).toEqual([]);
    pass.kill();
    await new Promise((r) => setTimeout(r, 1500));
    // The pass ended, but launchd still says the job runs: still nothing.
    expect(await readFile(f.dest, "utf8")).toBe("OLD");
    const { rm } = await import("node:fs/promises");
    await rm(join(f.dir, "running"));
    expect((await done).code).toBe(0);
    expect(await readFile(f.dest, "utf8")).toBe("NEW");
    expect((await f.calls()).filter((c) => /^boot/.test(c))).toEqual(["bootout gui/501/com.example.job", `bootstrap gui/501 ${f.dest}`]);
    expect(await exists(f.pending)).toBe(false);
    expect(await exists(`${f.dest}.pmx-old`)).toBe(false);
    expect(await readFile(f.log, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ background job: reloaded with this pmx, Node and Claude Code\n$/);
  }, 30000);

  it("waits in any launchd state but idle: just after a start the job is \"xpcproxy\", not yet \"running\" (rig test of #144)", async () => {
    const f = await fakeLaunchctl();
    await writeFile(f.dest, "OLD");
    await writeFile(f.pending, "NEW");
    await writeFile(join(f.dir, "running"), "xpcproxy");
    // The pass that asked has already ended (a pid that isn't running).
    const gone = spawn("true");
    await new Promise((r) => gone.on("exit", r));
    const { cmd, args } = reloadCommand(f.plan(gone.pid!));
    const done = exec(cmd, args, { timeoutMs: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await readFile(f.dest, "utf8")).toBe("OLD");
    expect((await f.calls()).filter((c) => /^boot/.test(c))).toEqual([]);
    const { rm } = await import("node:fs/promises");
    await rm(join(f.dir, "running"));
    expect((await done).code).toBe(0);
    expect(await readFile(f.dest, "utf8")).toBe("NEW");
  }, 30000);

  it("puts the old job file back and loads it when the new one won't load, so the job is never left unloaded", async () => {
    const f = await fakeLaunchctl({ refuse: "NEW" });
    await writeFile(f.dest, "OLD");
    await writeFile(f.pending, "NEW");
    const { cmd, args } = reloadCommand(f.plan(999999)); // no such process: the pass has ended
    const r = await exec(cmd, args, { timeoutMs: 40000 });
    expect(r.code).toBe(1);
    expect(await readFile(f.dest, "utf8")).toBe("OLD");
    const boots = (await f.calls()).filter((c) => /^bootstrap/.test(c));
    expect(boots).toHaveLength(6); // five tries with the new file, then the old one
    expect(await readFile(f.log, "utf8")).toMatch(/background job: couldn't reload with this pmx, Node and Claude Code, so it runs as before\n$/);
    // What was asked for is still there for the next pass to try again.
    expect(await readFile(f.pending, "utf8")).toBe("NEW");
  }, 60000);

  it("does nothing when there's no new job file to load", async () => {
    const f = await fakeLaunchctl();
    await writeFile(f.dest, "OLD");
    const { cmd, args } = reloadCommand(f.plan(999999));
    expect((await exec(cmd, args, { timeoutMs: 20000 })).code).toBe(0);
    expect(await readFile(f.dest, "utf8")).toBe("OLD");
    expect((await f.calls()).filter((c) => /^boot/.test(c))).toEqual([]);
  });
});

describe("the background job refreshes itself after an update (UPGRADE-1)", () => {
  let cli: string;
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("pmx-claude-");
    const c = join(await tmp("pmx-cli-"), "cli.js");
    await writeFile(c, "");
    cli = realpathSync(c);
  });
  const current = async () => plist({ node: await stableNode(process.execPath), cli, pmxHome: pmxHome(), claude: null });
  const stale = () => plist({ node: "/gone/node", cli: "/gone/cli.js", pmxHome: pmxHome(), claude: null });

  it("needs nothing, from a background run too, when pmx, Node and Claude Code are where they were", async () => {
    const job = fakeLaunchd();
    await job.install(await current());
    expect(await jobStep.run(deps({ launchd: job, cliPath: cli }))).toBeNull();
    expect(job.later).toBeNull();
    expect((await loadState()).jobReload ?? null).toBeNull();
    // No step of PMX's own waits for a command someone runs any more.
    expect(AUTO_STEPS.filter((s) => s.interactiveOnly)).toEqual([]);
  });

  it("a background run asks for the reload once it has ended, changes nothing meanwhile, and the next run says it happened", async () => {
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.upgrade = { lastVersion: "0.40.3", from: "0.40.2", at: "2026-11-26T09:00:00.000Z", applied: {} }; });
    const job = fakeLaunchd();
    await job.install(stale());
    const steps = [jobStep];

    const first = await upgradeOnStart(deps({ launchd: job, cliPath: cli, now: () => new Date("2026-11-27T10:00:00Z") }), steps);
    expect(first.did).toEqual([]);
    expect(first.waiting).toEqual([{ id: "background-job", title: jobStep.title, why: JOB_RELOADS, self: true }]);
    expect(JOB_RELOADS).toBe("the background job is running right now: it reloads itself with this pmx, Node and Claude Code when that run ends");
    // The job as launchd has it is untouched while the run goes on; what it asked for waits.
    expect(job.plist).toBe(stale());
    expect(job.later).toContain(`<string>${cli}</string>`);
    expect(job.later).not.toContain("/gone/");
    expect((await loadState()).jobReload).toEqual({ at: "2026-11-27T10:00:00.000Z", tries: 1 });
    expect((await loadState()).upgrade!.applied).toEqual({});

    // The run ends, the reload happens, and the next background run records it: nobody typed anything.
    job.finishRun();
    const next = await upgradeOnStart(deps({ launchd: job, cliPath: cli }), steps);
    expect(next.waiting).toEqual([]);
    expect(next.did).toEqual([{ id: "background-job", title: jobStep.title, did: "refreshed the background job with this pmx, Node and Claude Code (it reloaded itself after a background run)" }]);
    expect((await loadState()).jobReload).toBeNull();
    expect(Object.keys((await loadState()).upgrade!.applied)).toEqual([`background-job@${v}`]);
  });

  it("asks again at each run while the reload hasn't happened, and counts the tries", async () => {
    const job = fakeLaunchd();
    await job.install(stale());
    for (let i = 1; i <= 2; i++) {
      await expect(jobStep.run(deps({ launchd: job, cliPath: cli }))).rejects.toBeInstanceOf(StepWaits);
      expect((await loadState()).jobReload!.tries).toBe(i);
      job.later = null; // the reload never ran
    }
    expect(job.plist).toBe(stale());
  });

  it("a command someone runs reloads at once when no pass is running, and asks for it after the pass when one is", async () => {
    const job = Object.assign(fakeLaunchd(), { busy: true });
    Object.assign(job, { running: async () => job.busy });
    await job.install(stale());
    await expect(jobStep.run(deps({ launchd: job, cliPath: cli, interactive: true }))).rejects.toThrow(/running right now/);
    expect(job.plist).toBe(stale());
    expect(job.later).toContain(cli);
    job.busy = false;
    expect(await jobStep.run(deps({ launchd: job, cliPath: cli, interactive: true }))).toBe("refreshed the background job with this pmx, Node and Claude Code");
    expect(job.plist).toContain(cli);
    expect((await loadState()).jobReload).toBeNull();
    // A launchd that can't reload later (none does now, but the interface allows it) waits, as before.
    const { reloadAfter: _, ...plain } = fakeLaunchd();
    const old = Object.assign(plain, { plist: stale(), installed: async () => stale(), running: async () => true });
    await expect(jobStep.run(deps({ launchd: old as any, cliPath: cli, interactive: true }))).rejects.toThrow(/^the background job is running right now$/);
  });

  it("the checklist says PMX finishes it by itself, and names the command only after several reloads never happened", async () => {
    const cl = (tries: number | null) => buildChecklist({
      now: new Date("2026-11-27T10:30:00Z"), version: v, personal: null, team: null, checks: [], claude: true, hasRemote: null, memoryFilled: null,
      state: { ...(EMPTY as any), upgrade: { lastVersion: v, from: "0.40.2", at: "2026-11-27T10:00:00.000Z", applied: {} }, jobReload: tries === null ? null : { at: "2026-11-27T10:00:00.000Z", tries } },
      proposals: null, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: null, extra: [],
    });
    const job = (c: ReturnType<typeof cl>) => c.sections.find((s) => s.id === "update")!.steps.find((s) => s.id === "update.background-job")!;

    const asked = cl(1);
    expect(job(asked)).toMatchObject({ status: "warn", auto: true, detail: "the background job reloads itself with this pmx when the background run in progress ends", fix: { kind: "pmx", asks: true } });
    // Every update step still open is PMX's own to finish: nothing is left for a person.
    expect(asked.upgrade!.pending.every((s) => s.auto)).toBe(true);
    expect(asked.upgrade!.left).toBe("Nothing to do.");
    // In Terminal the step says so too, and never reads as the PM's next step to do.
    expect(formatChecklist(asked)).toMatch(/  ! The background job runs this version with today's Node and Claude Code: the background job reloads itself with this pmx when the background run in progress ends\n      → nothing for you to do: PMX finishes it by itself \(pmx checklist --fix does it now\)\n/);
    expect(formatChecklist(asked)).toMatch(/\nAfter updating from 0\.40\.2: nothing to do\.\n/);

    const stuck = cl(JOB_RELOAD_TRIES);
    expect(job(stuck)).toMatchObject({ status: "warn", detail: `PMX asked the background job to reload itself ${JOB_RELOAD_TRIES} times, and it still runs with its old settings`, do: "pmx checklist --fix" });
    expect(job(stuck).auto).toBeUndefined();
    expect(stuck.upgrade!.left).toBe("Still to do by hand: pmx checklist --fix.");
    expect(leftLine([])).toBe("Nothing to do.");
  });
});

const EMPTY = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, caps: {}, collectReports: [], whatsNew: null };
