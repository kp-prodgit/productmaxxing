// UPGRADE-1, COMPAT-7 (0.41.0): one line after an update. The background run's first pass on a new version says once
// what the update still needs from a person, "Nothing to do." when nothing does. Where PMX Engine is on the Mac, PMX
// asks Engine's own updater whether a newer Engine is out and says so; it never installs Engine unattended. `pmxe`
// here is a stand-in script that logs what it was asked; nothing is installed and no notification is shown.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterUpdate, updatedMessage } from "../src/commands/after-update.js";
import { updateStep } from "../src/commands/autoupdate.js";
import { migrateReport, tickSteps } from "../src/commands/index.js";
import { exec, type Exec } from "../src/core/exec.js";
import { loadState, updateState } from "../src/core/state.js";
import { markFreshInstall } from "../src/core/upgrade.js";
import { currentVersion } from "../src/core/version.js";
import { engineLatest } from "../src/engine/bridge.js";
import { buildChecklist, formatChecklist, leftForPeople, leftLine, type Checklist, type Step } from "../src/setup/checklist.js";
import { freshHome, personal, pmxRepo, testCtx, tmp } from "./helpers.js";

const v = currentVersion();
const AT = "2026-11-27T10:00:00.000Z";
const EMPTY = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, caps: {}, collectReports: [], whatsNew: null };
/** Every update step this version has, done: an update that left PMX itself nothing more to do. */
const allApplied = () => Object.fromEntries(["app-skills", "mcp-entry", "background-job", "evidence-names-3", "follow-ups-requeue"].map((id) => [`${id}@${v}`, { at: AT, did: "nothing to do" }]).concat([["task-hours-always", { at: AT, did: "nothing to do" }], ["evidence-backfill", { at: AT, did: "nothing to do" }]]));
const updatedFrom = (from: string) => updateState((s) => { s.upgrade = { lastVersion: v, from, at: AT, applied: allApplied() }; });

/** The checklist of a set-up Mac, from the state on disk, with what a test adds. */
async function checklist(o: { engine?: string | null; checks?: { id: string; ok: boolean; level: "warn" | "fail"; detail: string }[] } = {}): Promise<Checklist> {
  return buildChecklist({
    now: new Date("2026-11-27T10:30:00Z"), version: v, personal: personal("/r"), team: null, checks: o.checks ?? [], state: { ...(EMPTY as any), ...(await loadState()) }, claude: true, hasRemote: true, memoryFilled: true,
    proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: o.engine ? { version: o.engine, checklist: {} } : null, extra: [],
  });
}

/** `pmxe`: its version, and what `update --check --json` reports. Every call is logged; a bare `update` would show. */
async function fakePmxe(o: { version?: string; latest?: string; busy?: string[]; answer?: string } = {}) {
  const dir = await tmp("fake-pmxe-");
  const cmd = join(dir, "pmxe");
  const version = o.version ?? "0.17.1", latest = o.latest ?? "0.18.0";
  const report = o.answer ?? JSON.stringify({ ok: true, current: version, latest, newer: latest !== version, workspace: null, busy: o.busy ?? [] });
  await writeFile(join(dir, "report"), report);
  await writeFile(cmd, `#!/bin/sh
echo "$@" >> "${dir}/log"
case "$*" in
  --version) echo ${version} ;;
  "update --check --json") cat "${dir}/report" ;;
  update*) echo "Updated pmx-engine from ${version} to ${latest}." ;;
esac
`);
  await chmod(cmd, 0o755);
  return { cmd, log: async () => (await readFile(join(dir, "log"), "utf8").catch(() => "")).split("\n").filter(Boolean) };
}

describe("what's left after an update, in one line (UPGRADE-1)", () => {
  const step = (o: Partial<Step>): Step => ({ id: "x", title: "X", status: "warn", detail: "", required: false, afterUpdate: true, ...o });

  it("says Nothing to do when nothing needs a person, and otherwise only what does", () => {
    expect(leftLine([])).toBe("Nothing to do.");
    // Steps PMX finishes by itself at a background run aren't a person's.
    expect(leftLine([step({ do: "pmx checklist --fix", auto: true })])).toBe("Nothing to do.");
    const pending = [
      step({ id: "claude.page", do: "Type /pmx-flow in the Claude app", who: "claude" }),
      step({ id: "update.background-job", do: "pmx checklist --fix", who: "you", auto: true }),
      step({ id: "setup.package", do: "pmx vendor --require, then commit .pmx/cli and pmx.config.json in a pull request.", who: "team-lead" }),
      step({ id: "engine.update", do: "PMX Engine 0.18.0 is out: run pmxe update", who: "you" }),
    ];
    expect(leftForPeople(pending).map((s) => s.id)).toEqual(["claude.page", "setup.package", "engine.update"]);
    expect(leftLine(pending)).toBe("Still to do by hand: Type /pmx-flow in the Claude app; your team lead: pmx vendor --require, then commit .pmx/cli and pmx.config.json in a pull request; PMX Engine 0.18.0 is out: run pmxe update.");
    expect(updatedMessage({ version: "0.41.0", headline: "One command to update a team.", left: "Nothing to do." })).toBe("pmx 0.41.0 is installed: One command to update a team. Nothing to do.");
    expect(updatedMessage({ version: "0.41.0", left: leftLine(pending.slice(0, 1)) })).toBe("pmx 0.41.0 is installed. Still to do by hand: Type /pmx-flow in the Claude app.");
  });
});

describe("the first background run on a new version says it once (UPGRADE-1)", () => {
  beforeEach(freshHome);
  const told = () => { const sent: [string, string][] = []; return { sent, notify: async (t: string, m: string) => { sent.push([t, m]); } }; };
  const ctx = async () => testCtx({ repo: (await pmxRepo()).repo });

  it("tells a Mac that was just updated, in the log and one notification, and never again for that version", async () => {
    await updatedFrom("0.40.2");
    const n = told();
    let asked = 0;
    const deps = { checklist: async () => { asked++; return checklist(); }, engine: async () => null, notify: n.notify };
    const line = await afterUpdate(await ctx(), deps);
    expect(line).toBe(`pmx ${v} is set up on this Mac, updated from 0.40.2. Nothing to do.`);
    expect(n.sent).toHaveLength(1);
    expect(n.sent[0]![0]).toBe("ProductMaxxing updated");
    expect(n.sent[0]![1]).toMatch(new RegExp(`^pmx ${v.replace(/\./g, "\\.")} is installed.*\\. Nothing to do\\.$`));
    expect((await loadState()).updateTold).toBe(v);
    // The next runs say nothing, and work nothing out.
    expect(await afterUpdate(await ctx(), deps)).toBeNull();
    expect(n.sent).toHaveLength(1);
    expect(asked).toBe(1);
    // It's one of the background run's steps, right after the update itself.
    expect(tickSteps.map(([name]) => name).slice(0, 3)).toEqual(["team", "update", "updated"]);
  });

  it("lists only what a person has to do: a page from before self-updating keeps its /pmx-flow", async () => {
    await updatedFrom("0.34.0");
    const n = told();
    const line = await afterUpdate(await ctx(), {
      engine: async () => null, notify: n.notify,
      checklist: () => checklist({ checks: [{ id: "flow.page", ok: false, level: "warn", detail: "your /pmx-flow page is from pmx 0.34.0: type /pmx-flow in the Claude app" }] }),
    });
    expect(line).toBe(`pmx ${v} is set up on this Mac, updated from 0.34.0. Still to do by hand: Type /pmx-flow in the Claude app.`);
    expect(n.sent[0]![1]).toMatch(/Still to do by hand: Type \/pmx-flow in the Claude app\.$/);
  });

  it("says nothing on a Mac that wasn't updated: a fresh install, a Mac never set up, or one already told", async () => {
    const n = told();
    const deps = { checklist: async () => { throw new Error("never worked out"); }, engine: async () => { throw new Error("never asked"); }, notify: n.notify };
    expect(await afterUpdate(await ctx(), deps)).toBeNull(); // no record of any version
    await markFreshInstall(new Date(AT));
    expect(await afterUpdate(await ctx(), deps)).toBeNull();
    // A PM who updated by hand read the same line in `pmx migrate`, which `pmx update` runs: not told twice.
    await updatedFrom("0.40.2");
    const report = await migrateReport(await checklist());
    expect(report).toMatch(new RegExp(`^pmx ${v.replace(/\./g, "\\.")}, updated from 0\\.40\\.2\\.`));
    expect(report).toMatch(/\n\nNothing else to do for this update\.\n\n/);
    expect(JSON.parse(await migrateReport(await checklist(), { json: true }))).toMatchObject({ format: 1, from: "0.40.2", to: v, pending: [], left: "Nothing to do." });
    expect((await loadState()).updateTold).toBe(v);
    expect(await afterUpdate(await ctx(), deps)).toBeNull();
    expect(n.sent).toEqual([]);
  });

  it("never claims nothing is left when it couldn't work the checklist out", async () => {
    await updatedFrom("0.40.2");
    const n = told();
    const line = await afterUpdate(await ctx(), { checklist: async () => { throw new Error("boom"); }, engine: async () => null, notify: n.notify });
    expect(line).toBe(`pmx ${v} is set up on this Mac, updated from 0.40.2. PMX couldn't work out what's left: pmx checklist shows it.`);
    expect(n.sent[0]![1]).not.toMatch(/Nothing to do/);
  });

  it("the checklist says it too, when it's true and when it isn't", async () => {
    await updatedFrom("0.40.2");
    const clean = await checklist();
    expect(clean.upgrade).toMatchObject({ from: "0.40.2", to: v, pending: [], left: "Nothing to do." });
    expect(formatChecklist(clean)).toMatch(/\n\nAfter updating from 0\.40\.2: nothing to do\.\n/);
    const open = await checklist({ checks: [{ id: "flow.page", ok: false, level: "warn", detail: "your /pmx-flow page is from pmx 0.34.0" }] });
    expect(formatChecklist(open)).toMatch(/\nStill to do after updating from 0\.40\.2:\n  ✘ PMX's page in Claude is current: Type \/pmx-flow in the Claude app\n/);
    expect(formatChecklist(open)).not.toMatch(/nothing to do\./);
    // A step PMX finishes by itself at its next run is never the PM's next step, and leaves nothing to do.
    await updateState((s) => { delete s.upgrade!.applied[`app-skills@${v}`]; });
    const self = await checklist();
    expect(self.upgrade!.pending.map((s) => [s.id, s.auto])).toEqual([["update.app-skills", true]]);
    expect(self.upgrade!.left).toBe("Nothing to do.");
    expect(formatChecklist(self)).toMatch(/\n      → nothing for you to do: PMX finishes it by itself \(pmx checklist --fix does it now\)\n/);
    expect(formatChecklist(self)).toMatch(/\n\nAfter updating from 0\.40\.2: nothing to do\.\n/);
    const others = self.sections.flatMap((x) => x.steps).filter((x) => (x.status === "todo" || x.status === "warn") && !x.auto);
    expect(self.next?.auto === true).toBe(others.length === 0);
    expect(formatChecklist({ ...self, next: self.upgrade!.pending[0]! })).toMatch(/\nNext: nothing for you\. PMX finishes "PMX's commands in the Claude app match this version" by itself at its next background run\.$/);
    // A Mac that wasn't updated says neither.
    await markFreshInstall(new Date(AT));
    expect(formatChecklist(await checklist())).not.toMatch(/After updating|Still to do after updating/);
  });

  it("the run that installs the update no longer sends its own notification: the new pmx's first run does", async () => {
    const { repo } = await pmxRepo();
    const calls: string[][] = [];
    const fake: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return cmd === "tar" ? { code: 0, stdout: JSON.stringify({ version: "99.0.0" }), stderr: "" } : cmd === "npm" && args[0] === "prefix" ? { code: 0, stdout: "/usr/local\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; };
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = await tmp("installed-");
    try {
      const c = { ...(await testCtx({ repo, team: { cli: { min: "0.5.0", autoUpdate: true } } })), exec: fake };
      expect(await updateStep(c)).toBe("auto-update: installed pmx 99.0.0");
    } finally { delete process.env.PMX_INSTALL_ROOT_FOR_TESTS; }
    // It installs, and runs nothing else: not the new pmx, and no notification.
    expect(calls.filter((c) => c[0] !== "tar" && c[0] !== "git" && !(c[0] === "npm" && (c[1] === "prefix" || c[1] === "install")))).toEqual([]);
  });
});

describe("PMX Engine rides along, where it's installed (COMPAT-7)", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });
  const ctx = async () => testCtx({ repo: (await pmxRepo()).repo });

  it("asks Engine's own updater whether a newer one is out, with --check, and never runs the update", async () => {
    const p = await fakePmxe();
    process.env.PMX_PMXE = p.cmd;
    expect(await engineLatest(exec)).toEqual({ current: "0.17.1", latest: "0.18.0", newer: true, busy: false });
    expect((await p.log()).filter((l) => l !== "--version")).toEqual(["update --check --json"]);

    const busy = await fakePmxe({ busy: ["release-1: sales is approved, waiting to be sent."] });
    process.env.PMX_PMXE = busy.cmd;
    expect(await engineLatest(exec)).toMatchObject({ newer: true, busy: true });
    const same = await fakePmxe({ latest: "0.17.1" });
    process.env.PMX_PMXE = same.cmd;
    expect(await engineLatest(exec)).toEqual({ current: "0.17.1", latest: "0.17.1", newer: false, busy: false });
    // An answer PMX doesn't know is no answer.
    for (const answer of ["not json", JSON.stringify({ ok: false, latest: "0.18.0" }), JSON.stringify({ ok: true, latest: "soon" })]) {
      const odd = await fakePmxe({ answer });
      process.env.PMX_PMXE = odd.cmd;
      expect(await engineLatest(exec)).toBeNull();
    }
  });

  it("reads an Engine on a test build: its release is newer than it, and an older release is not (RELEASING.md)", async () => {
    const p = await fakePmxe({ version: "0.18.0-next.2", latest: "0.18.0" });
    process.env.PMX_PMXE = p.cmd;
    expect(await engineLatest(exec)).toEqual({ current: "0.18.0-next.2", latest: "0.18.0", newer: true, busy: false });
    const ahead = await fakePmxe({ version: "0.18.0-next.2", latest: "0.17.1" });
    process.env.PMX_PMXE = ahead.cmd;
    expect(await engineLatest(exec)).toEqual({ current: "0.18.0-next.2", latest: "0.17.1", newer: false, busy: false });
  });

  it("never asks an Engine from before 0.5.2, whose update --json installed, and runs nothing where Engine isn't installed", async () => {
    const old = await fakePmxe({ version: "0.5.1" });
    process.env.PMX_PMXE = old.cmd;
    expect(await engineLatest(exec)).toBeNull();
    expect(await old.log()).toEqual(["--version"]);

    process.env.PMX_PMXE = "none";
    const calls: string[][] = [];
    const spy: Exec = async (c, a, o) => { calls.push([c, ...a]); return exec(c, a, o); };
    expect(await engineLatest(spy)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a newer Engine is one clear line in the run log and a step in the checklist, and it's never installed", async () => {
    const p = await fakePmxe();
    process.env.PMX_PMXE = p.cmd;
    await updatedFrom("0.40.2");
    const sent: string[] = [];
    const line = await afterUpdate(await ctx(), { engine: () => engineLatest(exec), checklist: () => checklist({ engine: "0.17.1" }), notify: async (_t, m) => { sent.push(m); } });
    expect(line).toBe(`pmx ${v} is set up on this Mac, updated from 0.40.2. Still to do by hand: PMX Engine 0.18.0 is out: run pmxe update.`);
    expect(sent[0]).toMatch(/Still to do by hand: PMX Engine 0\.18\.0 is out: run pmxe update\.$/);
    expect((await loadState()).engineUpdate).toMatchObject({ latest: "0.18.0", current: "0.17.1" });
    // Engine's update never ran: only its version and the check.
    expect((await p.log()).filter((l) => l !== "--version")).toEqual(["update --check --json"]);

    const cl = await checklist({ engine: "0.17.1" });
    const step = cl.sections.find((s) => s.id === "engine")!.steps.find((s) => s.id === "engine.update")!;
    expect(step).toMatchObject({ status: "warn", required: false, afterUpdate: true, who: "you", how: "terminal", do: "PMX Engine 0.18.0 is out: run pmxe update", fix: { kind: "claude", command: "/pmxe-setup" } });
    expect(step.detail).toBe("PMX Engine 0.18.0 is out, and this Mac runs 0.17.1. PMX's background run never installs PMX Engine: unattended, it installs only the PMX package your team reviewed");
    expect(formatChecklist(cl)).toMatch(/→ PMX Engine 0\.18\.0 is out: run pmxe update \(you\)/);
    // Once Engine on this Mac is at that version, the step is gone; and a Mac without Engine never has it.
    expect((await checklist({ engine: "0.18.0" })).sections.find((s) => s.id === "engine")!.steps.map((s) => s.id)).not.toContain("engine.update");
    expect((await checklist({ engine: null })).sections.find((s) => s.id === "engine")!.steps.map((s) => s.id)).not.toContain("engine.update");
    expect((await checklist({ engine: "0.18.0" })).upgrade!.left).toBe("Nothing to do.");
  });

  it("with Engine at its newest, or not on this Mac, the line says Nothing to do", async () => {
    const same = await fakePmxe({ latest: "0.17.1" });
    process.env.PMX_PMXE = same.cmd;
    await updatedFrom("0.40.2");
    expect(await afterUpdate(await ctx(), { engine: () => engineLatest(exec), checklist: () => checklist({ engine: "0.17.1" }), notify: async () => {} })).toMatch(/Nothing to do\.$/);

    await freshHome();
    process.env.PMX_PMXE = "none";
    await updatedFrom("0.40.2");
    expect(await afterUpdate(await ctx(), { engine: () => engineLatest(exec), checklist: () => checklist(), notify: async () => {} })).toMatch(/Nothing to do\.$/);
    expect((await loadState()).engineUpdate ?? null).toBeNull();
  });
});
