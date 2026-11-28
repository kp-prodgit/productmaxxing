import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COLLECT_TASK } from "../src/claude/tasks.js";
import { checkCollected, collectPrompt, collectScope, collectWindow } from "../src/collect/collect.js";
import { DEFAULT_TEAM, loadTeamConfig, type PersonalConfig } from "../src/core/config.js";
import { attended, filterItems, notAttended } from "../src/core/filter.js";
import { runCanaries } from "../src/core/canary.js";
import { formatReceipt } from "../src/explain/format.js";
import { paths } from "../src/core/paths.js";
import { readReceipt } from "../src/core/receipt.js";
import { loadState, updateState, type State } from "../src/core/state.js";
import type { SignalItem } from "../src/core/types.js";
import { privacyRules } from "../src/digest/gather.js";
import { NO_SYNTH_MAC } from "../src/inputs/inputs.js";
import { REACH, startOfDay } from "../src/meetings/ledger.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { buildChecklist, type ChecklistInputs } from "../src/setup/checklist.js";
import { synthesisLine, synthWindow } from "../src/synth/status.js";
import { formatTodos, parseTodos, reconcileTodos, refreshTodos, TODO_BATCH, type FoundTodo } from "../src/todo/todo.js";
import { runStatus } from "../src/commands/status.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T15:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "p" };
const SLACK = [{ connector: "Slack", places: ["#product-feedback"] }];
const TALK = "Jane: We export a CSV every Friday and it takes an hour. ".repeat(6);
const iso = (d: Date) => d.toISOString();

describe("how far back a collection reaches (F6, F10)", () => {
  beforeEach(freshHome);

  it("a Mac's first collection reaches back 14 days for meetings and 7 for threads, and the first synthesis reads all of it", async () => {
    expect(REACH).toEqual({ threads: 7, most: 14 });
    const first = collectWindow(null, NOW);
    expect(first).toEqual({ meetings: startOfDay(NOW, 14), threads: startOfDay(NOW, 7), first: true });
    // The first synthesis reads everything the first collection brought in: 14 days, the most any run reads (SIG-6).
    expect(synthWindow(null, NOW).since).toEqual(first.meetings);
    expect(synthWindow(null, NOW).since <= first.threads).toBe(true);
    expect(synthWindow("2026-10-01T10:00:00Z", NOW).since).toEqual(first.meetings);

    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR, synthesizer: "ana", inputs: SLACK }, personal: { handle: "ana" } });
    const p = await collectPrompt(ctx, { scope: "team" });
    expect(p).toContain(`List meetings that ended after ${iso(startOfDay(NOW, 14))} that I attended or that are shared with my team or workspace`);
    expect(p).toContain("This is the first collection on this Mac, so it reaches back 14 days: go through every page of results.");
    expect(p).toContain(`take the threads with a message after ${iso(startOfDay(NOW, 7))}`);
  });

  it("later runs keep the overlap: two hours before the last collection, threads at least two days back", async () => {
    const last = "2026-11-20T12:30:00.000Z";
    const later = collectWindow(last, NOW);
    expect(later).toEqual({ meetings: new Date("2026-11-20T10:30:00.000Z"), threads: new Date(NOW.getTime() - 2 * 86400000), first: false });
    // After a week off, the window starts where the last collection left off, threads included.
    expect(collectWindow("2026-11-10T12:30:00.000Z", NOW).threads).toEqual(new Date("2026-11-10T10:30:00.000Z"));

    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR, synthesizer: "ana", inputs: SLACK }, personal: { handle: "ana" } });
    await updateState((s) => { s.lastCollectAt = last; });
    const p = await collectPrompt(ctx, { scope: "team" });
    expect(p).toContain("List meetings that ended after 2026-11-20T10:30:00.000Z");
    expect(p).not.toContain("first collection on this Mac");
    expect(p).toContain(`take the threads with a message after ${iso(new Date(NOW.getTime() - 2 * 86400000))}`);
  });

  it("a long first run's files still carry an accepted code: the code is about when the run started, not the meeting", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, personal: { handle: "ana" } });
    await collectPrompt(ctx, { scope: "mine" });
    const code = (await loadState()).collectRuns!.at(-1)!.code;
    // Meetings from 13 days ago, saved by this run, checked when the run ends an hour later.
    const old = "2026-11-07";
    for (const n of ["a", "b"]) await writeTranscript(paths.transcripts(), `${old}-granola-${n}.md`, `---\ntitle: Acme ${n}\ndate: ${old}T14:00:00Z\nparticipants: jane@acme.example, ana@us.example\nsource: granola\nsource_id: gr-${n}\nowner: Ana Ito <ana@us.example>\nrun: ${code}\n---\n${TALK}`);
    const end = await testCtx({ repo, now: new Date(NOW.getTime() + 3600000), personal: { handle: "ana" } });
    const out = (await checkCollected(end)).join("\n");
    expect(out).toMatch(/Collected 2 new transcript/);
    expect(out).not.toMatch(/carry no code/);
  });
});

describe("the synthesis Mac collects the team's meetings (F9)", () => {
  beforeEach(freshHome);

  it("pmx collect --prompt asks for the team's meetings on the synthesis Mac by itself, so the task's prompt never changes", async () => {
    const { repo } = await pmxRepo();
    const here = await testCtx({ repo, now: NOW, team: { tracker: LINEAR, synthesizer: "ana" }, personal: { handle: "ana" } });
    const other = await testCtx({ repo, now: NOW, team: { tracker: LINEAR, synthesizer: "bo" }, personal: { handle: "ana" } });
    const none = await testCtx({ repo, now: NOW, team: { tracker: LINEAR }, personal: { handle: "ana" } });
    const noTracker = await testCtx({ repo, now: NOW, team: { synthesizer: "ana" }, personal: { handle: "ana" } });
    expect([collectScope(here), collectScope(other), collectScope(none), collectScope(noTracker)]).toEqual(["team", "mine", "mine", "mine"]);
    expect(collectScope(other, true)).toBe("team");
    // The scheduled task runs plain `pmx collect --prompt`: nothing to set up again in the Claude app.
    expect(COLLECT_TASK.prompt).toContain("Run `pmx collect --prompt` in a shell.");
    expect(COLLECT_TASK.prompt).not.toContain("--team");

    const team = await collectPrompt(here, { scope: collectScope(here) });
    expect(team).toMatch(/that I attended or that are shared with my team or workspace, and that have a transcript/);
    expect(team).toMatch(/run: [0-9a-f]{12}\n   scope: team\n   ---/);
    expect(team).toContain("Write the run line and the scope line exactly as shown");
    expect(team).toMatch(/with fromDate "[\d-]+" and limit 50/);
    const mine = await collectPrompt(other, { scope: collectScope(other) });
    expect(mine).toMatch(/that I attended, and that have a transcript/);
    expect(mine).not.toContain("scope: team");
    expect(mine).toMatch(/mine true and limit 50/);
  });

  it("a team meeting the PM wasn't in never feeds their to-dos; team runs still hold what the team's rules hold", async () => {
    const team = { ...DEFAULT_TEAM, internalDomains: ["us.example"], inputs: [] } as any;
    const personal = { handle: "ana", neverIngest: { people: [], channels: [], meetingTitles: [] }, sources: { transcriptDirs: [], slackChannel: null }, identity: { names: ["Ana Ito"], emails: ["ana@us.example"] } } as unknown as PersonalConfig;
    const m = (id: string, title: string, participants: string[], forTeam = true): SignalItem => ({
      id, kind: "transcript", ref: `/t/${id}.md`, title, at: "2026-11-19", participants, text: "Bo: I'll send the pricing sheet.\n\nAna: I'll check the export.", ...(forTeam ? { forTeam: { owner: "Ana Ito <ana@us.example>" } } : {}),
    });
    const items = [
      m("T1", "Acme renewal", ["jane@acme.example", "bo@us.example"]), // a teammate's customer call
      m("T2", "Planning", ["bo@us.example", "cy@us.example"]), // a teammate's internal meeting
      m("T3", "Bo / Cy", ["bo@us.example", "cy@us.example"]), // a teammate's 1:1
      m("T4", "Globex call", ["joe@globex.example", "ana@us.example"]), // the PM's own, collected for the team
      m("T5", "Roadmap", ["Ana", "bo@us.example"]), // the PM's own, by first name only
      m("T6", "Standup", ["bo@us.example"], false), // a team meeting collected before files carried the scope line
      m("T7", "Hallway chat", [], false), // no participant list: nothing says who was in it
    ];
    const todo = filterItems(items, privacyRules({ team, personal }, true));
    expect(todo.kept.map((i) => i.id)).toEqual(["T4", "T5", "T7"]);
    expect(todo.decisions.filter((d) => d.decision === "held").map((d) => [d.item.id, d.rule])).toEqual([["T1", "not-attended"], ["T2", "not-attended"], ["T3", "not-attended"], ["T6", "not-attended"]]);
    // Synthesis reads them under the team's rules: only calls with someone from outside, never a 1:1.
    const synth = filterItems(items, privacyRules({ team, personal }));
    expect(synth.kept.map((i) => i.id)).toEqual(["T1", "T4"]);
    expect(synth.decisions.find((d) => d.item.id === "T3")!.rule).toBe("one-on-one");
    expect(synth.decisions.find((d) => d.item.id === "T2")!.rule).toBe("no-external-participant");
    // Before PMX knows who the PM is, the file's own owner line says it.
    expect(attended(items[3]!, { emails: [], names: [] })).toBe(true);
    expect(attended(items[0]!, { emails: [], names: [] })).toBe(false);
  });

  it("a meeting with no scope line is held from the PM's to-dos when its participants don't include them (F9, upgraded Macs)", () => {
    const me = { names: ["Ana Ito"], emails: ["ana@us.example"] };
    const m = (participants: string[], extra: Partial<SignalItem> = {}): SignalItem => ({ id: "T1", kind: "transcript", ref: "/t/a.md", title: "Board prep", at: "2026-11-19", participants, text: "Bo: I'll send it.", ...extra });
    // The scope line only says why: a team meeting says the synthesis Mac collected it, any other names how many were in it.
    expect(notAttended(m(["bo@us.example", "cy@us.example", "Cy Lin <cy@us.example>"]), me)).toMatch(/^you aren't among its 3 participants, so it never feeds your own to-dos\. If you were in it under another name or email, give every name and email you use: `pmx todo --me <name> --me <email>`$/);
    expect(notAttended(m(["bo@us.example"], { forTeam: { owner: null } }), me)).toMatch(/^your synthesis Mac collected it for the team/);
    // The PM by email, by full name, or by first name only.
    for (const p of ["ANA@us.example", "Ana Ito", "Ana", "Ana Ito <ana@other.example>"]) expect(notAttended(m(["bo@us.example", p]), me)).toBeNull();
    // A meeting with no participant list is read as before, and so is every meeting until PMX knows who the PM is.
    expect(notAttended(m([]), me)).toBeNull();
    expect(notAttended(m(["bo@us.example"]), { names: [], emails: [] })).toBeNull();
    // Without a known identity, the file's own owner line (who collected it) still tells.
    expect(notAttended(m(["bo@us.example"], { owner: "Ana Ito <ana@us.example>" }), { names: [], emails: [] })).toMatch(/aren't among its 1 participant,/);
    expect(notAttended(m(["ana@us.example"], { owner: "Ana Ito <ana@us.example>" }), { names: [], emails: [] })).toBeNull();
    // Team runs never check attendance: synthesis reads every meeting under the team's rules.
    const team = { ...DEFAULT_TEAM, internalDomains: ["us.example"], inputs: [] } as any;
    const personal = { handle: "ana", neverIngest: { people: [], channels: [], meetingTitles: [] }, sources: { transcriptDirs: [], slackChannel: null }, identity: me } as unknown as PersonalConfig;
    const call = m(["jane@acme.example", "bo@us.example"]);
    expect(filterItems([call], privacyRules({ team, personal })).kept).toHaveLength(1);
    expect(filterItems([call], privacyRules({ team, personal }, true)).decisions[0]).toMatchObject({ decision: "held", rule: "not-attended" });
    // The fake confidential meetings every run checks are the PM's own here, so their topic still has to stop them.
    expect(runCanaries(privacyRules({ team, personal }, true))).toMatchObject({ failed: [] });
  });

  it("on the synthesis Mac, meetings collected before the scope line never reach Claude for to-dos, and pmx explain says why", async () => {
    const { repo } = await pmxRepo();
    const dir = await tmp("old-team-calls-");
    // Collected for the team by an older pmx: no scope line. The owner is the PM whose Mac collected them.
    const file = (name: string, title: string, participants: string) =>
      writeTranscript(dir, name, `---\ntitle: ${title}\ndate: 2026-11-19T14:00:00Z\nparticipants: ${participants}\nsource: granola\nsource_id: ${name}\nowner: Ana Ito <ana@us.example>\n---\nJane: Can you send the SOC 2 report?\n\nAna: Yes, I'll send it Friday.`);
    await file("mine.md", "Acme renewal", "jane@acme.example, ana@us.example");
    await file("theirs.md", "Globex renewal", "joe@globex.example, bo@us.example");
    await file("staff.md", "Staff meeting", "bo@us.example, cy@us.example, di@us.example");
    const runtime = mockRuntime(() => JSON.stringify({ todos: [] }));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { tracker: LINEAR, synthesizer: "ana", internalDomains: ["us.example"] }, personal: { handle: "ana", identity: { names: ["Ana Ito"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 2), dryRun: true });
    expect(r.meetings.read).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.prompt).toContain('title="Acme renewal"');
    expect(runtime.calls[0]!.prompt).not.toMatch(/Globex|Staff meeting/);
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.sources.filter((s) => s.rule === "not-attended")).toHaveLength(2);
    expect(receipt.canaries).toMatchObject({ failed: [] });
    const out = formatReceipt(receipt, []);
    expect(out).toContain("✘ left out  a file that's no longer in your folder: A meeting you weren't in, because you aren't among its 2 participants, so it never feeds your own to-dos");
    expect(out).toContain("A meeting you weren't in, because you aren't among its 3 participants");
  });

  it("on the synthesis Mac, pmx todo --refresh reads only the team meetings the PM was in", async () => {
    const { repo } = await pmxRepo();
    const dir = await tmp("team-calls-");
    const file = (name: string, title: string, participants: string) =>
      writeTranscript(dir, name, `---\ntitle: ${title}\ndate: 2026-11-19T14:00:00Z\nparticipants: ${participants}\nsource: granola\nsource_id: ${name}\nowner: Ana Ito <ana@us.example>\nscope: team\n---\nJane: Can you send the SOC 2 report?\n\nAna: Yes, I'll send it Friday.`);
    await file("mine.md", "Acme renewal", "jane@acme.example, ana@us.example");
    await file("theirs.md", "Globex renewal", "joe@globex.example, bo@us.example");
    const runtime = mockRuntime(() => JSON.stringify({ todos: [] }));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { tracker: LINEAR, synthesizer: "ana", internalDomains: ["us.example"] }, personal: { handle: "ana", identity: { names: ["Ana Ito"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
    expect(r.meetings.read).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.prompt).toContain('title="Acme renewal"');
    expect(runtime.calls[0]!.prompt).not.toContain("Globex");
    const receipt = await readReceipt(r.receiptId!);
    const held = receipt!.sources.find((s) => s.rule === "not-attended")!;
    expect(held).toMatchObject({ decision: "left-out" });
    // Not a private meeting: synthesis may read it, so the flow view's privacy check doesn't track it (FLOW-3).
    expect(held.keys).toBeUndefined();
  });

  it("other Macs say where tasks are suggested without claiming every call is read", async () => {
    const team = (o: object) => ({ ...DEFAULT_TEAM, tracker: LINEAR, ...o }) as any;
    expect(synthesisLine(team({ synthesizer: "bo" }), { handle: "ana" }, "ana@m1")).toBe("Synthesis: on bo's Mac, from the calls shared with your team in your meeting app. This Mac makes your own to-dos.");
    expect(synthesisLine(team({ synthesizer: "ana", inputs: SLACK }), { handle: "ana" }, "ana@m1")).toBe("Synthesis: this Mac, for the whole team: it collects your calls and the ones shared with your team, reads your team's channels and suggests tasks from them");
    expect(synthesisLine(team({}), { handle: "ana" }, "ana@m1")).toMatch(/^Synthesis: each Mac suggests tasks from its own calls; no synthesis Mac chosen/);
    expect(synthesisLine({ ...DEFAULT_TEAM } as any, { handle: "ana" }, "ana@m1")).toBeNull();
    expect(synthesisLine({ ...DEFAULT_TEAM, synthesizer: "ana", inputs: SLACK } as any, { handle: "ana" }, "ana@m1")).toBe("Synthesis: your team's channels are read on this Mac");
  });
});

describe("without a synthesis Mac, no channel is read, and PMX says so (F7)", () => {
  beforeEach(freshHome);

  it("the checklist shows a step to choose one, sent through the team's review on Sources, and pmx status says it in one line", async () => {
    const PERSONAL = { handle: "ana", machineId: "m1", repoPath: "/r", installedAt: "2026-11-08T07:25:00Z", taskHours: "always" } as unknown as PersonalConfig;
    const base: ChecklistInputs = {
      now: NOW, version: "0.37.0", personal: PERSONAL, team: { ...DEFAULT_TEAM, tracker: LINEAR } as any, checks: [], claude: false, hasRemote: true, memoryFilled: true,
      state: { collectReports: [], tickGaps: [] } as unknown as State, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: null, extra: [],
    };
    const step = (team: object) => buildChecklist({ ...base, team: { ...DEFAULT_TEAM, tracker: LINEAR, ...team } as any }).sections.flatMap((s) => s.steps).find((s) => s.id === "work.channels")!;
    expect(step({}).status).toBe("skip");
    const open = step({ inputs: SLACK });
    expect(open).toMatchObject({ status: "todo", who: "you", how: "page", fix: { kind: "page", label: "Open Sources", to: "tab:health/settings/sources" } });
    expect(open.detail).toBe(`${NO_SYNTH_MAC}. Your team approved 1 place in Slack, but only its synthesis Mac reads them, and it hasn't chosen one, so none is read`);
    expect(open.fix!.text).toMatch(/It goes to your team for review\.$/);
    expect(step({ inputs: SLACK, synthesizer: "ana" })).toMatchObject({ status: "done", detail: "your team's 1 approved place in Slack is read on this Mac, your team's synthesis Mac" });
    expect(step({ inputs: SLACK, synthesizer: "bo" }).detail).toMatch(/read on bo's Mac/);

    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: { kind: "none" }, inputs: SLACK }, personal: { handle: "ana" } });
    const status = (await runStatus(ctx)).split("\n");
    expect(status.filter((l) => l.startsWith("Synthesis:"))).toEqual([`Synthesis: ✘ ${NO_SYNTH_MAC} (PMX's page: Settings → Sources).`]);
  });

  it("pmx init makes a new team repo's first Mac its synthesis Mac, and leaves a team's own choice alone", async () => {
    const { runInit } = await import("../src/commands/init.js");
    const { scriptedAsker } = await import("../src/core/ask.js");
    const { exec } = await import("../src/core/exec.js");
    const { memoryKeychain } = await import("../src/core/keychain.js");
    const { fakeLaunchd } = await import("../src/core/launchd.js");
    const { quietOut } = await import("./helpers.js");
    const withClaude = async (cmd: string, args: string[], o?: any) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));
    const answers = (repo: string, root: string) => scriptedAsker({ "PMX repo checkout": repo, "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(root, "t"), "email domains": "acme.example", "background job": false });
    const root = await tmp();
    const repo = join(root, "pmx");
    const out = quietOut();
    await runInit({ askAll: true, ask: answers(repo, root), keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude as any, out, now: () => NOW, cliPath: "/x/cli.js" });
    expect((await loadTeamConfig(repo)).synthesizer).toBe("ana");
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).synthesizer).toBe("ana");
    expect(out.lines.join("\n")).toMatch(/Synthesis Mac {2}this one \(ana\), as your team's first/);

    // Joining a team that has its own: init never changes the team's settings.
    const { repo: joined } = await pmxRepo({ synthesizer: "bo" });
    await freshHome();
    const again = quietOut();
    await runInit({ askAll: true, ask: answers(joined, root), keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude as any, out: again, now: () => NOW, cliPath: "/x/cli.js" });
    expect((await loadTeamConfig(joined)).synthesizer).toBe("bo");
    expect(again.lines.join("\n")).not.toMatch(/Synthesis Mac/);
  });
});

describe("to-dos from meetings full of them (F11)", () => {
  beforeEach(freshHome);

  /** Seven meetings on seven days; the PM is Ana. */
  async function setup(reply: (ids: string[], earlier: { key: string; text: string }[], n: number) => object, n = 7) {
    const { repo } = await pmxRepo();
    const dir = await tmp("busy-");
    for (let d = 1; d <= n; d++) {
      const day = `2026-11-${String(10 + d).padStart(2, "0")}`;
      await writeTranscript(dir, `m${d}.md`, `---\ntitle: Meeting ${d}\ndate: ${day}T10:00:00Z\nparticipants: jane@acme.example, ana@us.example\n---\nJane: Can you look at item ${d}?\n\nAna: I'll look at item ${d}.`);
    }
    let call = 0;
    const runtime = mockRuntime((o) => {
      const ids = [...o.prompt.matchAll(/<item id="(T\d+)"/g)].map((m) => m[1]!);
      const earlier = [...o.prompt.matchAll(/^- (E\d+): "([^"]*)"/gm)].map((m) => ({ key: m[1]!, text: m[2]! }));
      return JSON.stringify(reply(ids, earlier, ++call));
    });
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"] }, personal: { identity: { names: ["Ana"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } });
    const titles = (ids: string[], prompt: string) => ids.map((id) => prompt.match(new RegExp(`<item id="${id}" kind="transcript" date="[^"]*" title="([^"]*)"`))![1]);
    return { ctx, runtime, titles };
  }

  it("reads at most three meetings per call, oldest first, and keeps every commitment", async () => {
    expect(TODO_BATCH).toBe(3);
    const { ctx, runtime, titles } = await setup((ids) => ({ todos: ids.map((id) => ({ text: `Do the thing in ${id}`, due: null, source: id, why: "You said so." })) }));
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    expect(r.calls).toBe(3);
    expect(runtime.calls.map((c) => titles([...c.prompt.matchAll(/<item id="(T\d+)"/g)].map((m) => m[1]!), c.prompt))).toEqual([
      ["Meeting 1", "Meeting 2", "Meeting 3"], ["Meeting 4", "Meeting 5", "Meeting 6"], ["Meeting 7"],
    ]);
    expect(r.added).toHaveLength(7);
    // Each call is told what the earlier ones found; the first is told nothing.
    expect(runtime.calls[0]!.prompt).not.toContain("To-dos from the PM's earlier meetings");
    expect(runtime.calls[2]!.prompt.match(/^- E\d+: /gm)).toHaveLength(6);
    const receipt = await readReceipt(r.receiptId!);
    expect(receipt!.model).toMatchObject({ calls: 3, tokens: 3000 });
    expect(receipt!.model!.costUsd).toBeCloseTo(0.03);
    expect(receipt!.todo).toMatchObject({ batches: 3 });
    // The skill asks for every first-person commitment before choosing (F11).
    expect(runtime.calls[0]!.prompt).toMatch(/list, in `commitments`, every first-person commitment the PM makes: "I'll…", "I will…", "let me…", "I can…", "I'll get back to you on…"/);
  });

  it("a later batch's meeting still drops a promise it shows kept, and merges a repeat (W6)", async () => {
    const { ctx } = await setup((ids, earlier, n) => {
      if (n === 1) return { todos: [
        { text: "Send Jane the one-pager", due: null, source: ids[0], why: "You offered." },
        { text: "Share the slide with Jane", due: null, source: ids[1], why: "You agreed." },
        { text: "Book the follow-up", due: null, source: ids[2], why: "You said you would." },
      ] };
      const key = (t: string) => earlier.find((e) => e.text === t)!.key;
      if (n === 2) return { done: [key("Send Jane the one-pager"), "E99"], todos: [{ text: "Share the slide with Jane by Friday", due: "2026-11-21", source: ids[0], why: "You said it again.", replaces: key("Share the slide with Jane") }] };
      return { todos: [] };
    });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    expect(r.added.map((t) => [t.text, t.due, t.source.title])).toEqual([
      ["Book the follow-up", null, "Meeting 3"],
      ["Share the slide with Jane by Friday", "2026-11-21", "Meeting 4"],
    ]);
    const receipt = await readReceipt(r.receiptId!);
    expect(receipt!.todo!.reconciled).toEqual([{ text: "Send Jane the one-pager", how: "done" }, { text: "Share the slide with Jane", how: "replaced", by: "T4" }]);
    // The changed one is kept once, citing both meetings.
    expect(r.added.find((t) => t.text.startsWith("Share"))!.also).toEqual([{ title: "Meeting 2", at: "2026-11-12", keys: expect.any(Array) }]);
  });

  it("a commitment said again in a later batch is kept once, citing both meetings, and only an explicit done drops one (F11 regression)", async () => {
    const { ctx, runtime } = await setup((ids, earlier, n) => {
      const key = (t: string) => earlier.find((e) => e.text === t)!.key;
      if (n === 1) return { todos: [
        { text: "Set up 30 minutes with Lee on the migration plan", due: "2026-11-14", source: ids[0], why: "You offered Lee time." },
        { text: "Send Jane the one-pager", due: null, source: ids[1], why: "You offered." },
        { text: "Talk to Sam about the renewal discount", due: null, source: ids[2], why: "You said you would." },
      ] };
      if (n === 2) return {
        // Lee's half hour comes up again: given again with "replaces" but also put in "done". A repeat is never dropped.
        done: [key("Set up 30 minutes with Lee on the migration plan"), { id: key("Send Jane the one-pager"), source: ids[1], why: "Jane said she got it." }],
        todos: [
          { text: "Set up 30 minutes with Lee on the migration plan", due: null, source: ids[2], why: "You raised it again.", replaces: key("Set up 30 minutes with Lee on the migration plan") },
          // The same words with no "replaces": still one to-do.
          { text: "Talk to Sam about the renewal discount", due: null, source: ids[0], why: "You said it again." },
        ],
      };
      // The last call mentions none of them: leaving one out never drops it.
      return { todos: [] };
    });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    expect(r.calls).toBe(3);
    expect(r.added.map((t) => [t.text, t.due, t.source.title, (t.also ?? []).map((a) => a.title)])).toEqual([
      ["Set up 30 minutes with Lee on the migration plan", "2026-11-14", "Meeting 6", ["Meeting 1"]],
      ["Talk to Sam about the renewal discount", null, "Meeting 4", ["Meeting 3"]],
    ]);
    // The third call is told the merged ones, by new IDs, and that leaving them out keeps them.
    expect(runtime.calls[2]!.prompt.match(/^- E\d+: .*/gm)).toEqual([
      '- E4: "Set up 30 minutes with Lee on the migration plan", due 2026-11-14, from the meeting on 2026-11-16',
      '- E5: "Talk to Sam about the renewal discount", from the meeting on 2026-11-14',
    ]);
    expect(runtime.calls[1]!.prompt).toContain("Anything else: leave it out.** It stays on the PM's list as it is: leaving an earlier to-do out never drops it.");
    expect(runtime.calls[1]!.prompt).toContain("The same topic coming up again is not done.");
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.todo!.reconciled).toEqual([
      { text: "Send Jane the one-pager", how: "done", by: "T5", why: "Jane said she got it." },
      { text: "Set up 30 minutes with Lee on the migration plan", how: "merged", by: "T6" },
      { text: "Talk to Sam about the renewal discount", how: "merged", by: "T4" },
    ]);
    expect(receipt.todo!.added.map((a) => [a.source, a.also])).toEqual([["T6", ["T1"]], ["T4", ["T3"]]]);
    const out = formatReceipt(receipt, []);
    expect(out).toContain("☐ Set up 30 minutes with Lee on the migration plan (due 2026-11-14)  [T6, T1]");
    // The meeting that shows it is named by its title and date, from the run's own sources.
    expect(out).toContain('done in "Meeting 5" on 2026-11-15 [T5], so dropped: Send Jane the one-pager. Jane said she got it.');
    expect(out).toContain("said again in a later meeting [T6], kept once citing both: Set up 30 minutes with Lee on the migration plan");
    expect(formatTodos(r.added)).toContain('from "Meeting 6" on 2026-11-16, also "Meeting 1" on 2026-11-11: You raised it again.');
  });

  it("the merge rule is PMX's own: absent stays, done drops, a repeat merges, and a call can cite two of its meetings", () => {
    let k = 0;
    const next = () => `N${++k}`;
    const day = (id: string) => ({ T1: "2026-11-11", T2: "2026-11-12", T3: "2026-11-13", T4: "2026-11-14" })[id] ?? "";
    const f = (key: string, text: string, source: string, due: string | null = null): FoundTodo => ({ key, text, due, source, why: "x", at: day(source), also: [] });
    const found = [f("E1", "Send the deck", "T1", "2026-11-20"), f("E2", "Ask Lee about SSO", "T1"), f("E3", "Book the review", "T2")];
    // Nothing said about them: all stay.
    expect(reconcileTodos(found, { todos: [], done: [] }, day, next)).toEqual({ found, reconciled: [] });
    const r = reconcileTodos(found, {
      done: [{ id: "E2", source: "T3", why: "Lee answered it." }, { id: "E1" }],
      todos: [
        { text: "send the deck!", due: null, source: "T3", why: "Again." },
        { text: "Draft the pricing note", due: null, source: "T4", why: "New.", also: ["T3"] },
      ],
    }, day, next);
    expect(r.found.map((x) => [x.key, x.text, x.due, x.source, x.also])).toEqual([
      ["E3", "Book the review", null, "T2", []],
      ["N1", "send the deck!", "2026-11-20", "T3", ["T1"]],
      ["N2", "Draft the pricing note", null, "T4", ["T3"]],
    ]);
    expect(r.reconciled).toEqual([{ text: "Ask Lee about SSO", how: "done", by: "T3", why: "Lee answered it." }, { text: "Send the deck", how: "merged", by: "T3" }]);
  });

  it("the batch size can be set, and one call does when the meetings fit", async () => {
    const { ctx, runtime } = await setup((ids) => ({ todos: ids.map((id) => ({ text: `Item ${id}`, due: null, source: id, why: "x" })) }), 3);
    expect((await refreshTodos(ctx, { since: startOfDay(NOW, 14), batch: 1 })).calls).toBe(3);
    expect(runtime.calls.every((c) => c.prompt.match(/<item id=/g)!.length === 1)).toBe(true);
  });

  it("ignores an earlier ID the call wasn't given, and a done list without earlier to-dos", () => {
    const text = JSON.stringify({ commitments: [{ source: "T1", said: "I'll send it" }], done: ["E1", 4], todos: [{ text: "Send it", due: null, source: "T1", why: "x", replaces: "E7" }] });
    expect(parseTodos(text, new Set(["T1"]))).toEqual({ todos: [{ text: "Send it", due: null, source: "T1", why: "x" }], dropped: [], done: [], overtaken: [] });
    expect(parseTodos(text, new Set(["T1"]), new Set(["E1", "E7"]))).toMatchObject({ todos: [{ replaces: "E7" }], done: [{ id: "E1" }] });
    // A done with the meeting that shows it and why; a meeting it wasn't given is ignored, and so is a done for a
    // to-do the same answer gives again.
    const more = JSON.stringify({
      done: [{ id: "E1", source: "T2", why: "Sam said it shipped." }, { id: "E3", source: "T9" }, "E7", "E1"],
      todos: [{ text: "Send it", due: null, source: "T1", why: "x", replaces: "E7", also: ["T2", "T9", "T1"] }],
    });
    expect(parseTodos(more, new Set(["T1", "T2"]), new Set(["E1", "E3", "E7"]))).toEqual({
      todos: [{ text: "Send it", due: null, source: "T1", why: "x", replaces: "E7", also: ["T2"] }],
      dropped: [],
      done: [{ id: "E1", source: "T2", why: "Sam said it shipped." }, { id: "E3" }],
      overtaken: [],
    });
  });

  it("the pmx-todo skill counts promises to colleagues and work done through someone else, and keeps others' promises out", async () => {
    const { ctx, runtime } = await setup(() => ({ todos: [] }), 1);
    await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    const p = runtime.calls[0]!.prompt;
    expect(p).toContain('"I\'ll talk to…", "I\'ll take this to…", "I\'ll follow up with…", "let\'s grab time…" when the PM is the one to set it up');
    expect(p).toMatch(/\*\*Work with colleagues counts\.\*\* A promise to talk to, raise something with, take a question to, follow up with, or set up time with a named colleague is a to-do, even when it never leaves the company/);
    expect(p).toMatch(/\*\*Getting something done through someone else counts\*\* when the PM said they would make it happen/);
    expect(p).toMatch(/\*\*Not the PM's:\*\* what someone else promised to do themself/);
    expect(p).toContain('"I\'ll talk to Sam about it" is not vague');
    expect(p).toContain("A commitment made in two meetings is one to-do: cite the later meeting in `source` and the other in `also`. A repeat is merged, never dropped.");
    expect(p).toContain("A commitment the PM makes in words you can still see is a to-do: write it from those words alone, never from what was cut.");
    expect(p).toContain("Never invent a to-do or a due date.");
  });
});
