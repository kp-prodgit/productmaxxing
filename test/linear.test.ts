import { beforeEach, describe, expect, it } from "vitest";
import { linearTracker } from "../src/tracker/linear.js";
import { followMoves } from "../src/tracker/follow.js";
import { freshHome } from "./helpers.js";

/** A tiny fake of Linear's GraphQL API: just enough to exercise the adapter. A team with an In Review state. */
const STATES = [
  { id: "S-back", name: "Backlog", type: "backlog", position: 0 }, { id: "S-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "S-prog", name: "In Progress", type: "started", position: 2 }, { id: "S-rev", name: "In Review", type: "started", position: 3 },
  { id: "S-done", name: "Done", type: "completed", position: 4 }, { id: "S-cxl", name: "Canceled", type: "canceled", position: 5 },
];
function fakeLinear(o: { states?: typeof STATES } = {}) {
  const states = o.states ?? STATES;
  const labels: { id: string; name: string; isGroup: boolean; parent: { name: string } | null }[] = [];
  const issues = new Map<string, any>();
  const calls: string[] = [];
  const updates: any[] = [];
  let n = 0;
  const labelNodes = (ids: string[]) => ({ nodes: ids.map((id) => labels.find((l) => l.id === id)!).map((l) => ({ id: l.id, name: l.name, parent: l.parent })) });
  issues.set("other", { id: "other", identifier: "ENG-1", title: "x", description: "", url: "", priority: 0, createdAt: "", project: { id: "eng" }, labelIds: [], comments: [] });

  const f = (async (_url: string, init: any) => {
    const { query, variables: v } = JSON.parse(init.body);
    const op = query.match(/^\s*(query|mutation)[^{]*\{\s*(\w+)/)![2];
    calls.push(op);
    const state = (id: string | undefined) => { const s = states.find((x) => x.id === id); return s ? { id: s.id, name: s.name, type: s.type } : null; };
    const view = (i: any) => ({ ...i, labels: labelNodes(i.labelIds), comments: { nodes: i.comments.map((body: string) => ({ body })) }, state: state(i.stateId), assignee: i.assigneeId ? { id: i.assigneeId } : null });
    let data: any;
    switch (op) {
      case "teams": data = { teams: { nodes: [{ id: "team1" }] } }; break;
      case "team": data = { team: /states/.test(query) ? { states: { nodes: states } } : { labels: { nodes: labels } } }; break;
      case "viewer": data = { viewer: { id: "user-me" } }; break;
      case "issueLabelCreate": {
        const parent = v.i.parentId ? { name: labels.find((l) => l.id === v.i.parentId)!.name } : null;
        const l = { id: `L${++n}`, name: v.i.name, isGroup: !!v.i.isGroup, parent };
        labels.push(l);
        data = { issueLabelCreate: { issueLabel: { id: l.id, name: l.name } } };
        break;
      }
      case "issueCreate": {
        const id = `I${++n}`;
        issues.set(id, { id, identifier: `PMX-${n}`, title: v.i.title, description: v.i.description, url: `https://linear.app/x/${id}`, priority: v.i.priority ?? 0, createdAt: "2026-11-03", project: { id: v.i.projectId }, labelIds: v.i.labelIds, comments: [], stateId: v.i.stateId ?? "S-back", assigneeId: null });
        data = { issueCreate: { issue: view(issues.get(id)) } };
        break;
      }
      case "issue": data = { issue: issues.has(v.id) ? view(issues.get(v.id)) : null }; break;
      case "issueUpdate": {
        updates.push({ id: v.id, ...v.i });
        const i = issues.get(v.id);
        for (const k of ["labelIds", "stateId", "assigneeId", "priority", "description", "title"]) if (k in v.i) i[k] = v.i[k];
        data = { issueUpdate: { success: true } };
        break;
      }
      case "commentCreate": issues.get(v.i.issueId).comments.push(v.i.body); data = { commentCreate: { success: true } }; break;
      case "project": data = { project: { issues: { nodes: [...issues.values()].filter((i) => i.project.id === v.id).map(view), pageInfo: { hasNextPage: false, endCursor: null } } } }; break;
      default: throw new Error(`unexpected ${op}`);
    }
    return new Response(JSON.stringify({ data }));
  }) as any;
  /** A person's move on Linear's own board. */
  const move = (id: string, stateId: string) => { issues.get(id).stateId = stateId; };
  const labelOf = (id: string, group: string) => issues.get(id).labelIds.map((x: string) => labels.find((l) => l.id === x)!).find((l: any) => l.parent?.name === group)?.name ?? null;
  /** A label-only change, as an older PMX Mac or an older team board makes it: the state stays. */
  const relabel = (id: string, group: string, name: string | null) => {
    const i = issues.get(id);
    i.labelIds = i.labelIds.filter((x: string) => labels.find((l) => l.id === x)!.parent?.name !== group);
    if (name) i.labelIds.push(labels.find((l) => l.parent?.name === group && l.name === name)!.id);
  };
  return { f, labels, issues, calls, updates, move, labelOf, relabel };
}

describe("Linear adapter (SCOPE-1, TASK-6, SEC-4)", () => {
  it("creates inbox tasks with label groups and maps them back", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const created = await t.createInbox({ title: "Draft SCIM one-pager", description: "Why\n\npmx:source T1\npmx:source S2 https://slack.com/x", category: "spec", size: "M", sources: ["T1", "S2"] });
    expect(created).toMatchObject({ status: "inbox", category: "spec", size: "M", sources: ["T1", "S2"] });
    expect(fake.labels.filter((l) => l.isGroup).map((l) => l.name).sort()).toEqual(["pmx-category", "pmx-size", "pmx-state", "pmx-status"]);

    await t.setStatus(created.id, "ready");
    await t.setAgent(created.id, "ana@m1");
    await t.comment(created.id, "pmx:pr https://github.com/acme/pmx/pull/7\nDrafted.");
    const got = await t.get(created.id);
    expect(got).toMatchObject({ status: "ready", agent: "ana@m1", prUrl: "https://github.com/acme/pmx/pull/7" });
    // One status label at a time.
    expect(fake.issues.get(created.id).labelIds.filter((id: string) => fake.labels.find((l) => l.id === id)!.parent?.name === "pmx-status")).toHaveLength(1);
    expect((await t.list({ status: ["ready"] })).map((x) => x.id)).toEqual([created.id]);
  });

  it("refuses to write to an issue outside the PMX project", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "oauth-token", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    await expect(t.setStatus("other", "done")).rejects.toThrow(/not in the PMX project \(SEC-4\)/);
    await expect(t.comment("other", "hi")).rejects.toThrow(/SEC-4/);
    expect(fake.calls).not.toContain("issueUpdate");
    expect(fake.calls).not.toContain("commentCreate");
  });
});

describe("roadmap theme labels in Linear (EQ-38)", () => {
  it("puts an approved theme in the pmx-theme group, created on first use", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const created = await t.createInbox({ title: "Offline photo capture", description: "d", category: "spec", size: "M", sources: [], theme: "Field capture" });
    expect(created.theme).toBe("Field capture");
    expect(fake.labels.filter((l) => l.isGroup).map((l) => l.name)).toContain("pmx-theme");
    expect(fake.labels.find((l) => l.name === "Field capture")!.parent).toEqual({ name: "pmx-theme" });
    expect((await t.createInbox({ title: "CSV export", description: "d", category: "spec", size: "S", sources: [] })).theme).toBeNull();
  });
});

describe("Linear's own state follows PMX's status (TASK-7)", () => {
  it("creates in Backlog or Todo, moves with each status in one save, records it, and leaves Blocked where it is", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const later = await t.createInbox({ title: "Later task", description: "d", category: "spec", size: "M", sources: [] });
    const now = await t.createInbox({ title: "Start-now task", description: "d", category: "spec", size: "M", sources: [], ready: true });
    expect(fake.issues.get(later.id).stateId).toBe("S-back");
    expect(fake.issues.get(now.id).stateId).toBe("S-todo");
    expect([fake.labelOf(later.id, "pmx-state"), fake.labelOf(now.id, "pmx-state")]).toEqual(["backlog", "unstarted"]);
    // No priority from PMX: nothing it knows at approval says how urgent a task is.
    expect(fake.issues.get(later.id).priority).toBe(0);
    expect(later.workflow).toMatchObject({ type: "backlog", recorded: "backlog", label: "inbox" });

    const seen: string[] = [];
    for (const s of ["claimed", "running", "review", "blocked", "done"] as const) {
      fake.updates.length = 0;
      await t.setStatus(now.id, s);
      expect(fake.updates).toHaveLength(1);
      expect(fake.updates[0].labelIds).toBeDefined();
      seen.push(`${s}:${fake.issues.get(now.id).stateId}:${fake.labelOf(now.id, "pmx-state")}`);
    }
    expect(seen).toEqual(["claimed:S-prog:started", "running:S-prog:started", "review:S-rev:started", "blocked:S-rev:started", "done:S-done:completed"]);
    expect(fake.labelOf(now.id, "pmx-status")).toBe("done");
    // The team's states are read once per run.
    expect(fake.calls.filter((c) => c === "team").length).toBeLessThanOrEqual(2);
  });

  it("puts a draft in review in the first started state when the team has no review state", async () => {
    const fake = fakeLinear({ states: STATES.filter((s) => s.id !== "S-rev") });
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await t.createInbox({ title: "T", description: "d", category: "spec", size: "S", sources: [], ready: true });
    await t.setStatus(c.id, "review");
    expect(fake.issues.get(c.id).stateId).toBe("S-prog");
  });

  it("records where a task really is when the team has no state to move it to, and doesn't loop", async () => {
    const fake = fakeLinear({ states: STATES.filter((s) => s.type !== "backlog") });
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await t.createInbox({ title: "T", description: "d", category: "spec", size: "S", sources: [], ready: true });
    await t.setStatus(c.id, "inbox");
    // Still in Todo, recorded as such: PMX's own write never reads as a person's move to Todo.
    expect(fake.issues.get(c.id).stateId).toBe("S-todo");
    expect(fake.labelOf(c.id, "pmx-state")).toBe("unstarted");
    expect((await t.get(c.id)).status).toBe("inbox");
    expect(await followMoves(t)).toEqual([]);
  });

  it("assigns a task an agent takes to the key's own user, and unassigns only that user (TASK-9)", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await t.createInbox({ title: "T", description: "d", category: "spec", size: "S", sources: [], ready: true });
    await t.setAgent(c.id, "ana@m1");
    expect(fake.issues.get(c.id).assigneeId).toBe("user-me");
    await t.setAgent(c.id, null);
    expect(fake.issues.get(c.id).assigneeId).toBeNull();
    fake.issues.get(c.id).assigneeId = "user-bob";
    await t.setAgent(c.id, null);
    expect(fake.issues.get(c.id).assigneeId).toBe("user-bob");
  });

  it("refuses a canary in a comment, like every other write", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await t.createInbox({ title: "T", description: "d", category: "spec", size: "S", sources: [] });
    await expect(t.comment(c.id, "PMX-CANARY-7c1e leaked")).rejects.toThrow(/canary/);
  });
});

describe("PMX follows a person's move in Linear (TASK-8)", () => {
  beforeEach(freshHome);

  it("a person's Backlog → Todo makes a task Ready, back to Backlog takes it out, each with one comment", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await t.createInbox({ title: "Later task", description: "d", category: "spec", size: "M", sources: [] });
    fake.move(c.id, "S-todo");
    // Agents see it Ready at once, before the label catches up.
    expect((await t.list({ status: ["ready"] })).map((x) => x.id)).toEqual([c.id]);
    expect((await t.get(c.id)).workflow).toMatchObject({ label: "inbox", type: "unstarted", name: "Todo", recorded: "backlog" });
    expect(await followMoves(t)).toEqual([expect.stringMatching(/followed a move in Linear to Todo: Ready for agents/)]);
    expect([fake.labelOf(c.id, "pmx-status"), fake.labelOf(c.id, "pmx-state")]).toEqual(["ready", "unstarted"]);
    expect(fake.issues.get(c.id).comments).toEqual(["PMX followed the move to Todo in Linear: this task is Ready for agents now."]);
    // Nothing more to follow: no second comment.
    expect(await followMoves(t)).toEqual([]);
    expect(fake.issues.get(c.id).comments).toHaveLength(1);

    fake.move(c.id, "S-back");
    expect((await t.get(c.id)).status).toBe("inbox");
    await followMoves(t);
    expect(fake.labelOf(c.id, "pmx-status")).toBe("inbox");
    expect(fake.issues.get(c.id).comments.at(-1)).toMatch(/back in the backlog/);
  });

  it("an older Mac or an older team board that moves only the label wins: PMX moves the state to match, quietly", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const board = await t.createInbox({ title: "Made ready on an older board", description: "d", category: "spec", size: "M", sources: [] });
    const mac = await t.createInbox({ title: "Taken by an older Mac", description: "d", category: "spec", size: "M", sources: [], ready: true });
    const back = await t.createInbox({ title: "Sent back on an older board", description: "d", category: "spec", size: "M", sources: [], ready: true });
    await t.setStatus(mac.id, "running"); // creates the running label
    await t.setStatus(mac.id, "ready");
    // An older board: inbox → ready, and ready → inbox, labels only. An older Mac's agent: ready → running, label only.
    fake.relabel(board.id, "pmx-status", "ready");
    fake.relabel(back.id, "pmx-status", "inbox");
    fake.relabel(mac.id, "pmx-status", "running");
    const read = await t.list();
    // The state is still where PMX recorded it, so none of these reads as a person sending it back or making it Ready.
    expect(read.map((x) => [x.title, x.status, x.workflow?.align ?? false])).toEqual([
      ["Made ready on an older board", "ready", true], ["Taken by an older Mac", "running", true], ["Sent back on an older board", "inbox", true],
    ]);
    expect(await followMoves(t)).toEqual(["brought 3 tasks' Linear status in step with PMX's"]);
    expect([board, mac, back].map((c) => `${fake.issues.get(c.id).stateId}:${fake.labelOf(c.id, "pmx-state")}`)).toEqual(["S-todo:unstarted", "S-prog:started", "S-back:backlog"]);
    expect([board, mac, back].flatMap((c) => fake.issues.get(c.id).comments)).toEqual([]);
    expect(await followMoves(t)).toEqual([]);
  });

  it("several Macs reading the same move write it once", async () => {
    const fake = fakeLinear();
    const a = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const b = linearTracker({ token: "lin_api_y", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const c = await a.createInbox({ title: "Later task", description: "d", category: "spec", size: "M", sources: [] });
    fake.move(c.id, "S-todo");
    // Both Macs read the move before either writes.
    const [seenA, seenB] = [(await a.get(c.id)).workflow!, (await b.get(c.id)).workflow!];
    const f = (w: typeof seenA) => ({ from: w.label!, to: "ready" as const, type: w.type, comment: "followed" });
    await a.follow(c.id, f(seenA));
    await b.follow(c.id, f(seenB));
    expect(fake.issues.get(c.id).comments).toEqual(["followed"]);
    // And an align read before a person's move doesn't undo it.
    fake.relabel(c.id, "pmx-status", "inbox");
    const stale = (await b.get(c.id)).workflow!;
    fake.move(c.id, "S-prog");
    expect(await b.align(c.id, "inbox", { type: stale.type, recorded: stale.recorded })).toBe(false);
    expect(fake.issues.get(c.id).stateId).toBe("S-prog");
  });

  it("a canceled task leaves the queue; one closed without review is left alone, never accepted", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const a = await t.createInbox({ title: "A", description: "d", category: "spec", size: "M", sources: [], ready: true });
    const b = await t.createInbox({ title: "B", description: "d", category: "spec", size: "M", sources: [], ready: true });
    const r = await t.createInbox({ title: "R", description: "d", category: "spec", size: "M", sources: [], ready: true });
    await t.setStatus(r.id, "review");
    fake.move(a.id, "S-cxl");
    fake.move(b.id, "S-done");
    fake.move(r.id, "S-done");
    const list = await t.list();
    expect(list.map((x) => x.title).sort()).toEqual(["B", "R"]);
    expect(list.find((x) => x.title === "B")).toMatchObject({ status: "ready", workflow: { held: expect.stringMatching(/closed in Linear without PMX's review/) } });
    expect(list.find((x) => x.title === "R")!.status).toBe("review");
    const said = await followMoves(t);
    expect(said).toEqual([expect.stringMatching(/left alone: closed in Linear/), expect.stringMatching(/left alone: closed in Linear/)]);
    expect(fake.labelOf(b.id, "pmx-status")).toBe("ready");
    expect(fake.labelOf(r.id, "pmx-status")).toBe("review");
    expect(fake.issues.get(r.id).comments).toEqual([]);
    // Said once, not on every pass.
    expect(await followMoves(t)).toEqual([]);
  });

  it("brings an issue from before TASK-7 in step once from its label, and never reads its state as a person's move", async () => {
    const fake = fakeLinear();
    const t = linearTracker({ token: "lin_api_x", teamKey: "PROD", projectId: "pmx", fetch: fake.f });
    const ready = await t.createInbox({ title: "Old ready", description: "d", category: "spec", size: "M", sources: [], ready: true });
    const inbox = await t.createInbox({ title: "Old backlog", description: "d", category: "spec", size: "M", sources: [] });
    // As an older PMX left them: no state recorded, all in the team's default state.
    for (const [c, state] of [[ready, "S-back"], [inbox, "S-todo"]] as const) {
      fake.relabel(c.id, "pmx-state", null);
      fake.issues.get(c.id).stateId = state;
    }
    const before = await t.list();
    expect(before.find((x) => x.title === "Old ready")).toMatchObject({ status: "ready", workflow: { align: true, recorded: null } });
    expect(before.find((x) => x.title === "Old backlog")).toMatchObject({ status: "inbox", workflow: { align: true } });
    expect(await followMoves(t)).toEqual(["brought 2 tasks' Linear status in step with PMX's"]);
    expect(fake.issues.get(ready.id).stateId).toBe("S-todo");
    expect(fake.issues.get(inbox.id).stateId).toBe("S-back");
    expect(fake.labelOf(ready.id, "pmx-state")).toBe("unstarted");
    expect(fake.issues.get(ready.id).comments).toEqual([]);
  });
});
