import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { budget } from "../src/budget/provider.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import type { Task } from "../src/core/types.js";
import { selectTasks } from "../src/pull/select.js";
import { followMoves } from "../src/tracker/follow.js";
import { checkRelay, overlay, readOutbox, relayDir, relayPrompt, relayTracker, type Snapshot } from "../src/tracker/relay.js";
import { followState, inTarget, pickState, STATE_FOR } from "../src/tracker/states.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, personal } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
const NOW = new Date("2026-11-06T10:00:00Z");

const node = (identifier: string, status: string, o: { state?: [string, string] | null; recorded?: string; assignee?: string | null } = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: "", url: `https://linear.app/x/${identifier}`, priority: 0, createdAt: "2026-11-01T00:00:00Z",
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }, ...(o.recorded ? [{ name: o.recorded, parent: { name: "pmx-state" } }] : [])] },
  comments: { nodes: [] },
  ...(o.state ? { state: { name: o.state[0], type: o.state[1] } } : {}),
  ...("assignee" in o ? { assignee: o.assignee ? { id: o.assignee } : null } : {}),
});

async function snapshot(issues: any[], over: Partial<Snapshot> = {}) {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues, ...over }));
}

describe("which side wins when PMX's label and Linear's state disagree (TASK-8)", () => {
  it("follows a person's move only where it can, and never reads a closed task as accepted", () => {
    const f = (label: any, type: string | null, recorded: string | null) => followState(label, type, recorded);
    expect(f("inbox", "backlog", "backlog")).toEqual({ kind: "none" });
    // The state moved away from what PMX recorded: a person moved it.
    expect(f("inbox", "unstarted", "backlog")).toEqual({ kind: "follow", to: "ready" });
    expect(f("ready", "backlog", "unstarted")).toEqual({ kind: "follow", to: "inbox" });
    expect(f("ready", "triage", "unstarted")).toEqual({ kind: "follow", to: "inbox" });
    expect(f("ready", "canceled", "unstarted")).toEqual({ kind: "drop" });
    expect(f("review", "completed", "started")).toMatchObject({ kind: "leave", why: expect.stringMatching(/without PMX's review/) });
    expect(f("ready", "completed", "unstarted")).toMatchObject({ kind: "leave" });
    expect(f("ready", "started", "unstarted")).toMatchObject({ kind: "leave", why: expect.stringMatching(/started by hand/) });
    expect(f("running", "unstarted", "started")).toMatchObject({ kind: "leave", why: expect.stringMatching(/run and its review go on/) });
    expect(f("done", "unstarted", "completed")).toMatchObject({ kind: "leave", why: expect.stringMatching(/keeps it done/) });
    // A move to a state that agrees with the label: nothing to follow, PMX records it.
    expect(f("inbox", "triage", "backlog")).toEqual({ kind: "align" });
    expect(f("blocked", "unstarted", "started")).toEqual({ kind: "align" });
    expect(f("blocked", "started", "started")).toEqual({ kind: "none" });
    // The state is where PMX recorded it but the label moved alone (an older Mac or board): the label wins.
    expect(f("ready", "backlog", "backlog")).toEqual({ kind: "align" });
    expect(f("inbox", "unstarted", "unstarted")).toEqual({ kind: "align" });
    expect(f("done", "started", "started")).toEqual({ kind: "align" });
    // An older snapshot, or no PMX label: the label alone decides, as before.
    expect(f("ready", null, null)).toEqual({ kind: "none" });
    expect(f(null, "unstarted", "unstarted")).toEqual({ kind: "none" });
    // No state recorded (from before TASK-7): nothing says who put it there (Linear's default could be Todo), so
    // the label decides, once; one already closed is left alone.
    expect(f("inbox", "unstarted", null)).toEqual({ kind: "align" });
    expect(f("ready", "backlog", null)).toEqual({ kind: "align" });
    expect(f("inbox", "backlog", null)).toEqual({ kind: "align" });
    expect(f("done", "completed", null)).toEqual({ kind: "align" });
    expect(f("review", "completed", null)).toMatchObject({ kind: "leave" });
  });

  it("maps each status to the team's state, preferring a review state for drafts in review", () => {
    const states = [{ name: "Backlog", type: "backlog", position: 1 }, { name: "Todo", type: "unstarted", position: 2 }, { name: "In Review", type: "started", position: 4 }, { name: "In Progress", type: "started", position: 3 }, { name: "Done", type: "completed", position: 5 }, { name: "Duplicate", type: "canceled", position: 7 }, { name: "Canceled", type: "canceled", position: 6 }];
    const name = (s: keyof typeof STATE_FOR) => (STATE_FOR[s] ? pickState(states, STATE_FOR[s]!)?.name : "(stays)");
    expect(Object.fromEntries((["inbox", "ready", "claimed", "running", "review", "done", "blocked"] as const).map((s) => [s, name(s)])))
      .toEqual({ inbox: "Backlog", ready: "Todo", claimed: "In Progress", running: "In Progress", review: "In Review", done: "Done", blocked: "(stays)" });
    expect(pickState(states, "canceled")?.name).toBe("Canceled");
    expect(inTarget({ type: "started", name: "In Progress" }, "review", states)).toBe(false);
    expect(inTarget({ type: "started", name: "In Progress" }, "review", states.filter((s) => s.name !== "In Review"))).toBe(true);
  });
});

describe("Linear's state through the Claude relay (TASK-7, TASK-8, TASK-9)", () => {
  beforeEach(freshHome);

  it("tells the sync task how to move states, record them and assign, and to export each issue's state", async () => {
    await snapshot([node("PMX-1", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted" })]);
    const t = relayTracker(team, () => {}, () => NOW);
    await t.setStatus("PMX-1", "review");
    await t.setAgent("PMX-1", "ana@m1");
    const p = await relayPrompt(team);
    expect(p).toMatch(/`set-status`: on the target, in one save: .*move the issue to that workflow state and set its pmx-state label to the type of the state it's in afterwards\. With no `state` \(blocked\), leave its workflow state and its pmx-state label as they are\./);
    expect(p).toMatch(/`set-agent`: .*assign the issue to yourself, the Linear user this connector acts as \("me"\)\. If `value` is null, .*remove the assignee only if it is you/);
    expect(p).toMatch(/`follow-state`: only if the target's pmx-status label is still `from` and its workflow state's type is still `type`: replace that label with `to` from pmx-status, set its pmx-state label to `type`/);
    expect(p).toMatch(/`align-state`: only if the target's workflow state's type is still `type` and its pmx-state label is still `recorded` \(no pmx-state label at all when `recorded` is null\)/);
    expect(p).toMatch(/`review` means the first started state whose name contains "review" \(any case\), or the first started state if there's none/);
    expect(p).toMatch(/If the issue is already in a state of that type .*leave it there\. If the team has no state of that type, leave the issue's state as it is\. Never create, rename or reorder a state\./);
    expect(p).toMatch(/"state": \{"name": .*"type": .*\},\n\s+"assignee": \{"id": .*\} or null/);
    expect(p).toMatch(/- pmx-state: triage, backlog, unstarted, started, completed, canceled/);
    expect(p).not.toMatch(/pmx-kind: task/);
    expect(p).toMatch(/Leave its priority and assignee empty\./);
    // Done tasks stay in the export however old: Linear now has them completed, and evidence counts read them all.
    expect(p).toMatch(/Include PMX's tasks \(issues with a pmx-status label and no pmx-kind: meeting label\) however long ago they were completed; leave out any other issue completed more than 14 days ago/);
  });

  it("reads an older snapshot from its labels alone", async () => {
    await snapshot([node("PMX-1", "ready"), node("PMX-2", "inbox")]);
    const t = relayTracker(team, () => {}, () => NOW);
    expect((await t.list()).map((x) => [x.identifier, x.status, x.workflow ?? null])).toEqual([["PMX-1", "ready", null], ["PMX-2", "inbox", null]]);
    expect(await followMoves(t)).toEqual([]);
    expect((await readOutbox()).ops).toEqual([]);
  });

  it("follows a person's move once, even when the sync hasn't caught up, and never twice", async () => {
    await snapshot([
      node("PMX-1", "inbox", { state: ["Todo", "unstarted"], recorded: "backlog" }), node("PMX-2", "ready", { state: ["Backlog", "backlog"], recorded: "unstarted" }),
      node("PMX-3", "ready", { state: ["Canceled", "canceled"], recorded: "unstarted" }), node("PMX-4", "review", { state: ["Done", "completed"], recorded: "started" }),
    ]);
    const t = relayTracker(team, () => {}, () => NOW);
    expect((await t.list()).map((x) => [x.identifier, x.status, x.workflow?.held ?? null])).toEqual([
      ["PMX-1", "ready", null], ["PMX-2", "inbox", null], ["PMX-4", "review", expect.stringMatching(/without PMX's review/)],
    ]);
    const said = await followMoves(t);
    expect(said).toEqual([
      "PMX-1 followed a move in Linear to Todo: Ready for agents", "PMX-2 followed a move in Linear to Backlog: back in the backlog",
      expect.stringMatching(/^PMX-4 left alone: closed in Linear without PMX's review/),
    ]);
    const ops = (await readOutbox()).ops;
    expect(ops.map(({ id, at, ...o }) => o)).toEqual([
      { kind: "follow-state", target: "PMX-1", from: "inbox", to: "ready", type: "unstarted", comment: "PMX followed the move to Todo in Linear: this task is Ready for agents now." },
      { kind: "follow-state", target: "PMX-2", from: "ready", to: "inbox", type: "backlog", comment: "PMX followed the move to Backlog in Linear: this task is back in the backlog, and agents don't take it." },
    ]);
    // The queued change already counts on this Mac: nothing to follow again, and PMX-4 isn't logged twice.
    expect(await followMoves(t)).toEqual([]);
    expect((await readOutbox()).ops).toHaveLength(2);
    expect((await t.get("PMX-1")).workflow).toMatchObject({ label: "ready", recorded: "unstarted" });
  });

  it("several Macs reading the same move write it once: a change queued from a stale copy applies only if nothing moved", async () => {
    // This Mac queued its follow from an older copy; another Mac's sync already followed the same move.
    await snapshot([node("PMX-1", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted" })]);
    const t = relayTracker(team, () => {}, () => NOW);
    const { ops } = await readOutbox();
    ops.push({ id: "aaaaaaaaaaaaaaaa", at: NOW.toISOString(), kind: "follow-state", target: "PMX-1", from: "inbox", to: "ready", type: "unstarted", comment: "PMX followed the move" } as any);
    await writeFile(join(relayDir(), "outbox.json"), JSON.stringify({ v: 1, ops }));
    const n = overlay(JSON.parse(await (await import("node:fs/promises")).readFile(join(relayDir(), "snapshot.json"), "utf8")), (await readOutbox()).ops)[0];
    expect(n.comments.nodes).toEqual([]);
    expect(await followMoves(t)).toEqual([]);
  });

  it("an older Mac or an older board that moves only the label wins: PMX moves the state to match, quietly", async () => {
    await snapshot([
      // An older team board's Make ready: label ready, state still Backlog as PMX recorded it.
      node("PMX-1", "ready", { state: ["Backlog", "backlog"], recorded: "backlog" }),
      // An older Mac's agent took it: label running, state still Todo as recorded.
      node("PMX-2", "running", { state: ["Todo", "unstarted"], recorded: "unstarted" }),
      // An issue from before TASK-7: nothing recorded.
      node("PMX-3", "inbox", { state: ["Todo", "unstarted"] }),
    ]);
    const t = relayTracker(team, () => {}, () => NOW);
    expect((await t.list()).map((x) => [x.identifier, x.status, !!x.workflow?.align])).toEqual([["PMX-1", "ready", true], ["PMX-2", "running", true], ["PMX-3", "inbox", true]]);
    expect(await followMoves(t)).toEqual(["brought 3 tasks' Linear status in step with PMX's"]);
    expect((await readOutbox()).ops.map(({ id, at, ...o }) => o)).toEqual([
      { kind: "align-state", target: "PMX-1", value: "ready", state: "unstarted", type: "backlog", recorded: "backlog" },
      { kind: "align-state", target: "PMX-2", value: "running", state: "started", type: "unstarted", recorded: "unstarted" },
      { kind: "align-state", target: "PMX-3", value: "inbox", state: "backlog", type: "unstarted", recorded: null },
    ]);
    expect(await followMoves(t)).toEqual([]);
    expect((await t.get("PMX-1")).workflow).toMatchObject({ type: "unstarted", recorded: "unstarted" });
    expect((await t.get("PMX-3")).workflow).toMatchObject({ type: "backlog", recorded: "backlog" });
  });

  it("assigns through set-agent, and the overlay shows PMX's own writes as made, never as a person's move", async () => {
    await snapshot([node("PMX-1", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null })]);
    const t = relayTracker(team, () => {}, () => NOW);
    await t.setAgent("PMX-1", "ana@m1");
    await t.setStatus("PMX-1", "claimed");
    await t.setStatus("PMX-1", "running");
    const ops = (await readOutbox()).ops;
    expect(ops.map(({ id, at, ...o }) => o)).toEqual([
      { kind: "set-agent", target: "PMX-1", value: "ana@m1" },
      { kind: "set-status", target: "PMX-1", value: "claimed", state: "started" },
      { kind: "set-status", target: "PMX-1", value: "running", state: "started" },
    ]);
    const got = await t.get("PMX-1");
    expect(got).toMatchObject({ status: "running", agent: "ana@m1", workflow: { type: "started", label: "running" } });
    expect(got.workflow?.held).toBeUndefined();
    await t.setStatus("PMX-1", "blocked");
    expect((await readOutbox()).ops.at(-1)).toMatchObject({ kind: "set-status", value: "blocked" });
    expect((await readOutbox()).ops.at(-1)).not.toHaveProperty("state");
    await t.setAgent("PMX-1", null);
    expect(overlay(JSON.parse(JSON.stringify({ v: 1, syncedAt: "", projectId: "proj-1", issues: [node("PMX-1", "ready", { assignee: null })] })), (await readOutbox()).ops)[0].assignee).toBeNull();
  });

  it("--check reconciles the state, assignee and priority each applied change asked for", async () => {
    await snapshot([node("PMX-1", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null }), node("PMX-2", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null })]);
    const t = relayTracker(team, () => {}, () => NOW);
    await t.setAgent("PMX-1", "ana@m1");
    await t.setStatus("PMX-1", "running");
    await t.setPriority("PMX-1", 2);
    await t.setStatus("PMX-2", "review");
    const ops = (await readOutbox()).ops;
    await writeFile(join(relayDir(), "results.json"), JSON.stringify(ops.map((o) => ({ id: o.id, ok: true }))));
    // Claude says done, but PMX-1 is still in Todo, unassigned, with no priority; PMX-2 really is in review.
    await snapshot([node("PMX-1", "running", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null }), node("PMX-2", "review", { state: ["In Review", "started"], recorded: "started", assignee: null })]);
    const out = (await checkRelay(team, NOW)).join("\n");
    expect(out).toMatch(/Applied 4 change\(s\) in Linear; 0 still waiting/);
    expect(out).toMatch(/⚠ PMX-1 is in Todo, not a started state, not assigned, priority 0, not 2 in Linear, though the change was reported done\./);
    expect(out).not.toMatch(/PMX-2 is/);
  });
});

describe("the memory tracker keeps a workflow like Linear's (TASK-7, TASK-8)", () => {
  beforeEach(freshHome);

  it("moves with each status, follows a person's move, and leaves a closed task alone", async () => {
    const tr = memoryTracker();
    const a = await tr.createInbox({ title: "A", description: "d", category: "spec", size: "M", sources: [] });
    expect(tr.workflow.get(a.id)).toEqual({ type: "backlog", name: "Backlog", recorded: "backlog" });
    await tr.setStatus(a.id, "ready");
    expect(tr.workflow.get(a.id)!.name).toBe("Todo");
    await tr.setStatus(a.id, "review");
    expect(tr.workflow.get(a.id)!.name).toBe("In Review");
    await tr.setStatus(a.id, "blocked");
    expect(tr.workflow.get(a.id)!.name).toBe("In Review");

    const b = await tr.createInbox({ title: "B", description: "d", category: "spec", size: "M", sources: [] });
    Object.assign(tr.workflow.get(b.id)!, { type: "unstarted", name: "Todo" });
    expect((await tr.get(b.id)).status).toBe("ready");
    expect(await followMoves(tr)).toEqual([`${b.identifier} followed a move in Linear to Todo: Ready for agents`]);
    expect(tr.tasks.get(b.id)!.status).toBe("ready");
    expect(tr.comments.get(b.id)).toEqual(["PMX followed the move to Todo in Linear: this task is Ready for agents now."]);

    const c = await tr.createInbox({ title: "C", description: "d", category: "spec", size: "M", sources: [], ready: true });
    Object.assign(tr.workflow.get(c.id)!, { type: "completed", name: "Done" });
    const held = await tr.get(c.id);
    expect(held).toMatchObject({ status: "ready", workflow: { held: expect.stringMatching(/closed in Linear/) } });
    // Pull never takes it, and it isn't accepted.
    const p = personal("/r");
    const s = selectTasks({ tasks: [held], agent: "ana@m1", personal: p, team, now: NOW, budget: budget(p, team, { ledger: {} } as any, NOW), inReview: 0, pausedCategories: new Map(), leasedTaskIds: new Set() });
    expect(s.candidates).toEqual([]);
    expect(s.decisions[0]!.why).toMatch(/closed in Linear without PMX's review/);
    expect(tr.tasks.get(c.id)!.status).toBe("ready");

    // An older Mac changes only the label: the state is still where PMX recorded it, so the label wins.
    const e = await tr.createInbox({ title: "E", description: "d", category: "spec", size: "M", sources: [] });
    tr.tasks.get(e.id)!.status = "ready";
    expect((await tr.get(e.id))).toMatchObject({ status: "ready", workflow: { align: true } });
    await followMoves(tr);
    expect(tr.workflow.get(e.id)).toEqual({ type: "unstarted", name: "Todo", recorded: "unstarted" });
    expect(tr.comments.get(e.id)).toBeUndefined();

    const d = await tr.createInbox({ title: "D", description: "d", category: "spec", size: "M", sources: [] });
    Object.assign(tr.workflow.get(d.id)!, { type: "canceled", name: "Canceled" });
    expect((await tr.list()).map((x: Task) => x.title)).not.toContain("D");
  });

  it("assigns the Mac's own user when an agent takes a task, and unassigns only that user", async () => {
    const tr = memoryTracker();
    const a = await tr.createInbox({ title: "A", description: "d", category: "spec", size: "M", sources: [], ready: true });
    await tr.setAgent(a.id, "ana@m1");
    expect(tr.assignees.get(a.id)).toBe("me");
    await tr.setAgent(a.id, null);
    expect(tr.assignees.get(a.id)).toBeNull();
    tr.assignees.set(a.id, "bob");
    await tr.setAgent(a.id, null);
    expect(tr.assignees.get(a.id)).toBe("bob");
  });
});
