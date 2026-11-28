import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { companyStep } from "../src/commands/meetings.js";
import { synthStep } from "../src/commands/team.js";
import { rollup } from "../src/company/rollup.js";
import type { Ctx } from "../src/core/context.js";
import { gateKey, loadGates, saveGate } from "../src/core/gates.js";
import { paths } from "../src/core/paths.js";
import { registerServices, services } from "../src/core/services.js";
import { loadState } from "../src/core/state.js";
import type { Task } from "../src/core/types.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { heldOverCount } from "../src/synth/held-over.js";
import { synthesize, threadPrint, threadsUnchanged } from "../src/synth/synthesize.js";
import { memoryTracker, type Tracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, writeTranscript } from "./helpers.js";

/**
 * No model call when nothing changed (MEET-3, COMPANY-1): the background run's reread of channel and email threads and
 * its daily company roll-up call the model only when what it would read differs from the last time it read it. What
 * was read is remembered in ~/.pmx/gates.json; without it, the step runs.
 */

const NOW = new Date("2026-11-06T15:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600000);
const at = <T extends Ctx>(ctx: T, when: Date): T => ({ ...ctx, now: () => when });
const linear = { kind: "linear", teamKey: "PMX", projectId: "proj-1" } as const;

// The tracker the background steps get from `services(ctx)`: each test sets its own.
let injected: Tracker = memoryTracker();
registerServices({ tracker: async () => injected });

const thread = (name: string, body: string) =>
  writeTranscript(paths.threads(), name, `---\nkind: thread\ntitle: #product-feedback\ndate: 2026-11-06T13:00:00Z\nplace: #product-feedback\nparticipants: rowan@orchard.example\nsource: slack\nsource_id: C1:${name}\nowner: Ana <ana@harbor.example>\n---\n${body}`);

describe("the 6-hourly reread of channel and email threads (MEET-3)", () => {
  beforeEach(freshHome);

  async function setup() {
    const { repo } = await pmxRepo();
    await thread("exports.md", "Rowan: Our admins export the member list by hand every week and paste it into the console.");
    await thread("alerts.md", "Rowan: The usage alerts arrive a day late, so we find out after the invoice.");
    injected = memoryTracker();
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [] }));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["harbor.example"], tracker: linear, inputs: [{ connector: "Slack", places: ["#product-feedback"] }] } });
    return { ctx, runtime };
  }

  it("reads the threads once, then makes no model call while none changes, and says so in the log", async () => {
    const { ctx, runtime } = await setup();
    // Nothing is remembered yet, so the first reread reads.
    expect(await synthStep(ctx)).toBeNull();
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.prompt).toContain("export the member list by hand");
    expect(Object.keys((await loadGates()).synth!.threads)).toHaveLength(2);
    // Hashes only: what the threads said never reaches the file.
    expect(await readFile(paths.gates(), "utf8")).not.toMatch(/member list|usage alerts|Rowan|orchard/);

    // Within 6 hours nothing is due: silent, as before.
    expect(await synthStep(at(ctx, hours(1)))).toBeNull();
    expect(runtime.calls).toHaveLength(1);

    // The reread is due and no thread changed: no model call, and a line in the log saying why.
    const line = await synthStep(at(ctx, hours(7)));
    expect(line).toBe("skipped, nothing changed: the 2 channel and email threads are as the model last read them (2026-11-06 15:00 UTC), so no model call");
    expect(runtime.calls).toHaveLength(1);
    // The check counts as the reread: the next one is due 6 hours later, not at the next pass.
    expect((await loadState()).lastSynthAt).toBe(hours(7).toISOString());
    expect(await synthStep(at(ctx, hours(8)))).toBeNull();
    // A skipped reread spends nothing and writes no receipt of a run that didn't happen.
    expect(Object.values((await loadState()).ledger).reduce((a, b) => a + b, 0)).toBeCloseTo(0.01);
  });

  it("reads again, once, when one thread has a new message, with every thread in the window as today", async () => {
    const { ctx, runtime } = await setup();
    await synthStep(ctx);
    await appendFile(join(paths.threads(), "alerts.md"), "\n\nRowan: Now the alerts stopped altogether since Tuesday.");
    expect(await synthStep(at(ctx, hours(7)))).toBeNull(); // a read that suggested nothing says nothing, as before
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.prompt).toContain("alerts stopped altogether");
    expect(runtime.calls[1]!.prompt).toContain("export the member list by hand");
    // That read is what's remembered now, so the next reread is quiet again.
    expect(await synthStep(at(ctx, hours(14)))).toMatch(/^skipped, nothing changed: the 2 channel and email threads .*\(2026-11-06 22:00 UTC\), so no model call$/);
    expect(runtime.calls).toHaveLength(2);
  });

  it("reads again for a thread that wasn't there at the last read", async () => {
    const { ctx, runtime } = await setup();
    await synthStep(ctx);
    await thread("billing.md", "Rowan: Can invoices go to two addresses? Finance and the budget owner both need them.");
    await synthStep(at(ctx, hours(7)));
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.prompt).toContain("Can invoices go to two addresses");
  });

  it("still reads for the needs the last run held over, which wait for the next run (SIG-9)", async () => {
    const { repo } = await pmxRepo();
    await thread("exports.md", "Rowan: Our admins export the member list by hand every week and paste it into the console.");
    injected = memoryTracker();
    let reply: object = { tasks: [], heldOver: [{ title: "Understand the weekly member export", category: "spec", sources: ["C1"], why: "It costs an admin an hour a week." }] };
    const runtime = mockRuntime(() => JSON.stringify(reply));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["harbor.example"], tracker: linear, inputs: [{ connector: "Slack", places: ["#product-feedback"] }] } });
    await synthStep(ctx);
    expect(await heldOverCount()).toBe(1);
    // No thread changed, but a held-over need is waiting for this reread: it runs, and the model is offered the need.
    reply = { tasks: [] };
    await synthStep(at(ctx, hours(7)));
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.prompt).toContain("Understand the weekly member export");
    // Nothing is held over any more, so the next reread of the same thread is skipped.
    expect(await heldOverCount()).toBe(0);
    expect(await synthStep(at(ctx, hours(14)))).toMatch(/^skipped, nothing changed: the 1 channel or email thread is as the model last read it \(2026-11-06 22:00 UTC\), so no model call$/);
    expect(runtime.calls).toHaveLength(2);
  });

  it("runs when what was read isn't remembered: the file missing, unreadable or shaped differently", async () => {
    const { ctx, runtime } = await setup();
    await synthStep(ctx);
    await rm(paths.gates());
    await synthStep(at(ctx, hours(7)));
    expect(runtime.calls).toHaveLength(2);

    await writeFile(paths.gates(), "{ not json");
    expect(await loadGates()).toEqual({});
    await synthStep(at(ctx, hours(14)));
    expect(runtime.calls).toHaveLength(3);

    await writeFile(paths.gates(), JSON.stringify({ synth: { at: 5, threads: "all of them" } }));
    await synthStep(at(ctx, hours(21)));
    expect(runtime.calls).toHaveLength(4);
    // And the run that read leaves it readable again.
    expect(await synthStep(at(ctx, hours(28)))).toMatch(/^skipped, nothing changed/);
    expect(runtime.calls).toHaveLength(4);
  });

  it("always reads when a person runs synthesis, and never skips on a dry run's word", async () => {
    const { ctx, runtime } = await setup();
    const svc = await services(ctx);
    const opts = { days: 3, since: startOfDay(NOW) };
    await synthesize(ctx, svc, opts);
    // `pmx synthesize`: the PM asked, so the model is asked, whatever is remembered.
    const again = await synthesize(ctx, svc, opts);
    expect(again.unchanged).toBeUndefined();
    expect(runtime.calls).toHaveLength(2);
    // A dry run leaves nothing remembered that a later reread could lean on.
    await rm(paths.gates());
    await synthesize(ctx, svc, { ...opts, dryRun: true });
    expect((await loadGates()).synth).toBeUndefined();
  });

  it("tells a thread by what the model would read of it, not by when it was saved", async () => {
    const t = { kind: "thread" as const, origin: { source: "slack", sourceId: "C1:a" }, place: "#product-feedback", title: "#product-feedback", text: "Rowan: The export is slow." };
    expect(threadPrint(t)).toBe(threadPrint({ ...t }));
    expect(threadPrint({ ...t, text: `${t.text}\n\nRowan: Still slow today.` })).not.toBe(threadPrint(t));
    expect(threadPrint({ ...t, place: "#billing" })).not.toBe(threadPrint(t));
    // No thread in the window is nothing to skip a call for.
    await freshHome();
    expect(await threadsUnchanged([])).toBeNull();
    await saveGate("synth", { at: NOW.toISOString(), threads: { [threadPrint(t)]: NOW.toISOString() } });
    const item = { ...t, id: "C1", ref: "/x/a.md", at: "2026-11-06", participants: [] };
    expect(await threadsUnchanged([item])).toBe(NOW.toISOString());
    expect(await threadsUnchanged([item, { ...item, text: "Rowan: Something else." }])).toBeNull();
  });
});

describe("the daily company roll-up (COMPANY-1)", () => {
  beforeEach(freshHome);

  const t = (identifier: string, title: string): Task => ({
    id: identifier, identifier, title, description: "", url: `https://linear.app/x/${identifier}`, category: "spec", size: "M",
    status: "inbox", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
  });
  const reply = JSON.stringify({ themes: [{ title: "Decide on member exports across admin and growth", category: "spec", size: "L", rationale: "Both teams hear export asks.", tasks: ["admin/ADM-1", "growth/GRO-4"] }] });

  async function setup() {
    const teams = { admin: memoryTracker([t("ADM-1", "Member export one-pager"), t("ADM-2", "Audit log filters")]), growth: memoryTracker([t("GRO-4", "Member export for self-serve")]) };
    registerServices({ project: async (_ctx, p) => teams[p.projectId as keyof typeof teams] });
    injected = memoryTracker();
    const runtime = mockRuntime(() => reply);
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { tracker: linear, synthesizer: "ana", company: { machine: null, teams: [{ name: "admin", teamKey: "ADM", projectId: "admin" }, { name: "growth", teamKey: "GRO", projectId: "growth" }] } } });
    return { ctx, runtime, teams, company: () => injected as ReturnType<typeof memoryTracker> };
  }

  it("makes no model call when the teams' tasks are the same as yesterday, keeps what it posted, and says so in the log", async () => {
    const { ctx, runtime, company } = await setup();
    expect(await companyStep(ctx)).toBe("company roll-up: 1 theme(s) posted");
    expect(runtime.calls).toHaveLength(1);
    expect(await companyStep(at(ctx, hours(2)))).toBeNull(); // once a day

    const line = await companyStep(at(ctx, hours(25)));
    expect(line).toBe("company roll-up: skipped, nothing changed: the teams' 3 open task(s) are as they were at the last roll-up (2026-11-06 15:00 UTC), so no model call and its themes stand");
    expect(runtime.calls).toHaveLength(1);
    // The previous result is kept: the theme it posted is still there, once.
    expect([...company().tasks.values()].map((x) => x.title)).toEqual(["Decide on member exports across admin and growth"]);
    // It counts as the day's roll-up, so the next is a day later.
    expect((await loadState()).lastRollupAt).toBe(hours(25).toISOString());
    expect(await companyStep(at(ctx, hours(26)))).toBeNull();
  });

  it("uses the last answer in place of a new call, so a theme that never reached the company project still does", async () => {
    const { ctx, runtime, company } = await setup();
    await companyStep(ctx);
    // As if the first roll-up had stopped before posting: an empty company project, the same team tasks.
    injected = memoryTracker();
    expect(await companyStep(at(ctx, hours(25)))).toMatch(/so no model call and its themes stand; 1 theme\(s\) from it posted now$/);
    expect(runtime.calls).toHaveLength(1);
    expect([...company().tasks.values()].map((x) => x.description)).toEqual([expect.stringContaining("pmx:from growth/GRO-4")]);
  });

  it("asks the model again when a team's tasks changed", async () => {
    const { ctx, runtime, teams } = await setup();
    await companyStep(ctx);
    await teams.growth.setStatus("GRO-4", "ready");
    expect(await companyStep(at(ctx, hours(25)))).toBe("company roll-up: 0 theme(s) posted"); // already rolled up
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.prompt).toContain('ref="growth/GRO-4" team="growth" status="ready"');
  });

  it("runs when the last roll-up isn't remembered, and always when a person runs it", async () => {
    const { ctx, runtime } = await setup();
    await companyStep(ctx);
    await rm(paths.gates());
    expect(await companyStep(at(ctx, hours(25)))).toBe("company roll-up: 0 theme(s) posted");
    expect(runtime.calls).toHaveLength(2);

    await writeFile(paths.gates(), "\u0000 unreadable");
    await companyStep(at(ctx, hours(50)));
    expect(runtime.calls).toHaveLength(3);

    // A key from other inputs is no reason to skip.
    await saveGate("rollup", { at: NOW.toISOString(), key: gateKey("other", "inputs"), answer: reply });
    await companyStep(at(ctx, hours(75)));
    expect(runtime.calls).toHaveLength(4);

    // `pmx company`: the model is asked, whatever is remembered.
    const byHand = await rollup(at(ctx, hours(76)), await services(ctx));
    expect(byHand.unchanged).toBeUndefined();
    expect(runtime.calls).toHaveLength(5);
  });
});
