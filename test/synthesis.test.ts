import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ttyAsker } from "../src/core/ask.js";
import { isoWeek } from "../src/core/context.js";
import { runDigest } from "../src/commands/digest.js";
import { stagingPath } from "../src/digest/digest.js";
import { applyPersonal, checkChange, loosens } from "../src/flow/actions.js";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { runningWebServer, webServerFile } from "../src/flow/web-server.js";
import { estimateCost, formatSynthStatus, neverSynthesized, synthesizesHere, synthStatus, synthWindow } from "../src/synth/status.js";
import { addTodo, COMMITMENT, loadTodos, sendTodoToLinear } from "../src/todo/todo.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-12T15:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "p1" };
const meeting = (title: string, date: string, people: string, id: string) =>
  `---\ntitle: ${title}\ndate: ${date}T14:00:00Z\nparticipants: ${people}\nsource: fireflies\nsource_id: ${id}\n---\n${"Jane: We export a CSV every Friday and it breaks. ".repeat(6)}`;

describe("0.25.0: tasks are proposed without anyone running pmx synthesize (SIG-6)", () => {
  beforeEach(freshHome);

  it("a Mac proposes tasks from its own calls until the team picks one synthesis Mac", () => {
    const me = { handle: "ana" };
    expect(synthesizesHere({ synthesizer: null, tracker: LINEAR }, me, "ana@m1")).toBe(true);
    expect(synthesizesHere({ synthesizer: "ana", tracker: LINEAR }, me, "ana@m1")).toBe(true);
    expect(synthesizesHere({ synthesizer: "bo", tracker: LINEAR }, me, "ana@m1")).toBe(false);
    expect(synthesizesHere({ synthesizer: null, tracker: { kind: "none" } }, me, "ana@m1")).toBe(false);
  });

  it("each run reads from a day before the last one, 7 days the first time, never more than 14", () => {
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const local = (iso: string) => { const d = new Date(iso); d.setHours(0, 0, 0, 0); return d; };
    expect(synthWindow(null, NOW).since.getTime()).toBe(local("2026-11-05T12:00:00").getTime());
    expect(synthWindow("2026-11-10T09:00:00Z", NOW).since.getTime()).toBe(local("2026-11-09T12:00:00").getTime());
    expect(synthWindow("2026-09-01T09:00:00Z", NOW).since.getTime()).toBe(local("2026-10-29T12:00:00").getTime());
    expect(day(synthWindow("2026-11-12T14:00:00Z", NOW).since)).toBe(day(local("2026-11-11T12:00:00")));
    expect(synthWindow(null, NOW).days).toBeGreaterThanOrEqual(8);
  });

  it("says why no task is waiting: meetings not read yet, with a cost, or every meeting kept out, by rule", async () => {
    const { repo } = await pmxRepo();
    const dir = await tmp();
    await writeTranscript(dir, "sync.md", meeting("Team sync", "2026-11-11", "ana@us.com, sam@us.com", "ff-1"));
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.com"], tracker: LINEAR, synthesizer: null }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const allHeld = await synthStatus(ctx, { local: true, receipts: [], automatic: true, lastSynthAt: null });
    expect(allHeld).toMatchObject({ where: "here", counts: { meetings: 1, pending: 0, read: 0, held: 1 }, heldBy: [{ rule: "no-external-participant", n: 1 }] });
    expect(allHeld.reason).toMatch(/kept all of them out of tasks: 1 internal-only \(no one from outside the company\)\. Tasks come only from calls with someone outside your company/);
    // The meeting kept out is listed by date and rule only, never its title.
    expect(allHeld.meetings).toEqual([{ at: expect.any(String), outcome: "held", title: null, rule: "no-external-participant", label: "No one from outside the company" }]);

    await writeTranscript(dir, "acme.md", meeting("Acme renewal", "2026-11-12", "jane@acme.com, ana@us.com", "ff-2"));
    const pending = await synthStatus(ctx, { local: true, receipts: [], automatic: false, lastSynthAt: null });
    expect(pending.counts).toEqual({ meetings: 2, pending: 1, read: 0, held: 1 });
    expect(pending.reason).toMatch(/^1 customer meeting hasn't been read for tasks yet\. Automatic runs are off, so they wait until you run it\. Reading them costs (about \$[\d.]+|under \$0\.01)\./);
    expect(pending.meetings[0]).toMatchObject({ outcome: "pending", title: "Acme renewal" });
    const text = formatSynthStatus(pending, NOW);
    expect(text).toMatch(/^No new tasks are waiting\./);
    expect(text).toContain("Last synthesis: never.");
    expect(text).toMatch(/Read them now: pmx synthesize --since \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/To-dos are different: .* never leave this Mac\. Tasks go to Linear only after you approve them\./);
    // The shared level gets counts and the reason, never the meetings.
    expect((await synthStatus(ctx, { local: false, receipts: [], automatic: true, lastSynthAt: null })).meetings).toEqual([]);

    const elsewhere = await testCtx({ repo, now: NOW, team: { tracker: LINEAR, synthesizer: "bo" }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    expect((await synthStatus(elsewhere, { local: true, receipts: [], automatic: true, lastSynthAt: null })).reason).toMatch(/suggested on bo, your team's synthesis Mac/);
    const none = await testCtx({ repo, now: NOW, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    expect((await synthStatus(none, { local: true, receipts: [], automatic: true, lastSynthAt: null })).where).toBe("off");
  });

  it("estimates a run's cost from past runs, or from the meetings' length before the first", () => {
    expect(estimateCost([], [])).toBeNull();
    expect(estimateCost([{ chars: 40000 }], [])).toBeCloseTo(18000 * 3e-6 + 3000 * 15e-6);
    const past = [{ type: "synthesize", dryRun: false, model: { costUsd: 0.3 }, sources: [{ decision: "used" }, { decision: "used" }, { decision: "used" }, { decision: "left-out" }] }] as any;
    expect(estimateCost([{ chars: 1 }, { chars: 1 }], past)).toBeCloseTo(0.2);
  });

  it("doctor warns when meetings were collected but this Mac never proposed a task", async () => {
    const dir = await tmp();
    await writeTranscript(dir, "acme.md", meeting("Acme", "2026-11-12", "jane@acme.com", "ff-3"));
    const team = { synthesizer: null, tracker: LINEAR };
    const personal = { handle: "ana", sources: { transcriptDirs: [dir], slackChannel: null } };
    expect(await neverSynthesized(team, personal, "ana@m1", null, false)).toMatch(/^Linear is connected and 1 meeting file\(s\) were collected in the last 14 days, but this Mac has never suggested a task from them \(automatic runs are off\)\. `pmx proposals` says why/);
    expect(await neverSynthesized(team, personal, "ana@m1", "2026-11-11T00:00:00Z", true)).toBeNull();
    expect(await neverSynthesized({ ...team, synthesizer: "bo" }, personal, "ana@m1", null, true)).toBeNull();
    expect(await neverSynthesized(team, { ...personal, sources: { transcriptDirs: [await tmp()], slackChannel: null } }, "ana@m1", null, true)).toBeNull();
  });
});

describe("0.25.0: your own to-dos can go to Linear, only if you turn it on (SIG-7)", () => {
  beforeEach(freshHome);

  it("is a personal setting that asks before turning on", async () => {
    const team = { tracker: LINEAR } as any;
    const c = checkChange({ kind: "todos-linear", value: true }, team);
    expect(c).toEqual({ kind: "todos-linear", value: true });
    expect(loosens(c, { todosToLinear: false } as any)).toBe(true);
    expect(loosens({ kind: "todos-linear", value: false }, { todosToLinear: true } as any)).toBe(false);
    expect(() => checkChange({ kind: "todos-linear", value: "yes" }, team)).toThrow(/on or off/);
    expect(() => checkChange({ kind: "todos-linear", value: true }, { tracker: { kind: "none" } } as any)).toThrow(/no task tracker/);
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    expect(await applyPersonal(ctx.personal, [c])).toEqual(["Let me send my own to-dos to Linear, one at a time"]);
    expect(ctx.personal.todosToLinear).toBe(true);
  });

  it("sends only the to-do's words, as a commitment agents never take, and only once", async () => {
    const t = await addTodo({ text: "Send Acme the SOC 2 report", due: "2026-11-14" }, NOW);
    const sent: any[] = [];
    const tracker = { createInbox: async (x: any) => (sent.push(x), { identifier: "PRO-9" }) };
    const ctx = { team: { tracker: LINEAR }, personal: { handle: "ana", todosToLinear: false } } as any;
    await expect(sendTodoToLinear(ctx, tracker, t.id)).rejects.toThrow(/is off, so they stay on this Mac/);
    expect(sent).toEqual([]);
    ctx.personal.todosToLinear = true;
    expect(await sendTodoToLinear(ctx, tracker, t.id)).toEqual({ identifier: "PRO-9", text: "Send Acme the SOC 2 report", already: false });
    expect(sent[0]).toMatchObject({ title: "Send Acme the SOC 2 report", category: COMMITMENT, sources: [] });
    expect(sent[0].description).toMatch(/A commitment ana made, due 2026-11-14/);
    expect(sent[0].description).toMatch(/no meeting title, transcript, attendees or quotes/);
    expect((await loadTodos()).items[0]!.linear).toBe("PRO-9");
    expect(await sendTodoToLinear(ctx, tracker, t.id)).toMatchObject({ already: true });
    expect(sent).toHaveLength(1);
    await expect(sendTodoToLinear(ctx, tracker, "zzzzzz")).rejects.toThrow(/No to-do/);
  });
});

describe("0.25.0: setup fixes from a tester's report", () => {
  beforeEach(freshHome);

  it("pmx digest --review with no terminal keeps the staged digest instead of deleting it", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const week = isoWeek(NOW);
    await mkdir(dirname(stagingPath(week)), { recursive: true });
    await writeFile(stagingPath(week), "# Digest\nA staged draft.");
    const out = await runDigest(ctx, ttyAsker(true), { review: true });
    expect(out).toMatch(/^Kept for later at .*nothing reached git/);
    expect(await readFile(stagingPath(week), "utf8")).toContain("A staged draft.");
  });

  it("a second pmx flow --web opens the board already running, and stops one left from an older pmx", async () => {
    expect(await runningWebServer()).toBeNull();
    await mkdir(dirname(webServerFile()), { recursive: true });
    const url = "http://127.0.0.1:4567/flow#t=abc";
    await writeFile(webServerFile(), JSON.stringify({ pid: process.pid, url, version: currentVersion(), startedAt: NOW.toISOString() }));
    let asked = "";
    const fetchOk = (async (u: string, o: any) => { asked = `${u} ${o.headers.authorization}`; return { ok: true }; }) as any;
    expect(await runningWebServer({ fetch: fetchOk })).toMatchObject({ url });
    expect(asked).toBe("http://127.0.0.1:4567/api/pipeline?hours=1 Bearer abc");
    expect(await runningWebServer({ fetch: (async () => ({ ok: false })) as any })).toBeNull();
    // From an older pmx: stopped, so the board never shows old code.
    await writeFile(webServerFile(), JSON.stringify({ pid: process.pid, url, version: "0.1.0", startedAt: NOW.toISOString() }));
    const stopped: number[] = [];
    expect(await runningWebServer({ fetch: fetchOk, stop: (pid) => stopped.push(pid) })).toBeNull();
    expect(stopped).toEqual([process.pid]);
    // Gone: the note is cleared.
    await writeFile(webServerFile(), JSON.stringify({ pid: 999999, url, version: currentVersion(), startedAt: NOW.toISOString() }));
    expect(await runningWebServer({ fetch: fetchOk })).toBeNull();
    await expect(readFile(webServerFile(), "utf8")).rejects.toThrow();
    await rm(webServerFile(), { force: true });
  });

  it("the page explains an empty Inbox, offers Run synthesis, splits to-dos from tasks, and names an old server on Connect", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    expect(page).toContain("function synthCard()");
    expect(page).toContain("Run synthesis now${est}");
    expect(page).toContain('runNow("synthesize"');
    expect(page).toContain("What happened to each meeting");
    expect(page).toContain("To-dos come from all of them, 1:1s included, and never leave this Mac.");
    // A to-do reaches Linear through Where in its details (TODO-5), which moves it.
    expect(page).toContain('act("move", { ref, to, ...o })');
    expect(page).toMatch(/const PERSONAL = \[[^\]]*"todosLinear"\]/);
    expect(page).toContain("old_server:");
    expect(page).toMatch(/unknown tool\|tool not found/);
  });
});
