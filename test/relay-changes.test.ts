import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { COLLECT_TASK, LINEAR_SYNC_TASK, taskDescription, taskFile, taskState } from "../src/claude/tasks.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { checkRelay, enqueueSkillDoc, mergeChanges, pmxLabels, readOutbox, readSnapshot, readSyncRecord, relayDir, relayHealth, relayPrompt, relayTracker, syncPlan, type Snapshot, type SyncRecord } from "../src/tracker/relay.js";
import { freshHome, tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
const at = (h: number, m = 0, day = 20) => new Date(2026, 10, day, h, m); // November 2026, this Mac's time
const file = (name: string) => join(relayDir(), name);
const exists = (f: string) => stat(f).then(() => true, () => false);

/**
 * A stand-in for the team's Linear project, and for what the task in the Claude app does with it: export the whole
 * project (canceled issues left out), or list what was updated after a time (canceled ones included).
 */
function fakeLinear() {
  const issues = new Map<string, any>();
  const put = (identifier: string, when: Date, o: { labels?: [string, string][]; title?: string; description?: string; state?: string; comments?: string[] } = {}) => {
    const old = issues.get(identifier);
    issues.set(identifier, {
      id: `uuid-${identifier}`, identifier, title: o.title ?? old?.title ?? `Task ${identifier}`, description: o.description ?? old?.description ?? "", url: `https://linear.example/${identifier}`,
      priority: 3, createdAt: old?.createdAt ?? when.toISOString(), state: { name: o.state ?? old?.state.name ?? "Todo", type: (o.state ?? old?.state.name ?? "Todo") === "Canceled" ? "canceled" : "unstarted" }, assignee: null,
      labels: { nodes: (o.labels ?? old?.labels.nodes.map((l: any) => [l.parent.name, l.name]) ?? [["pmx-status", "ready"]]).map(([g, n]: [string, string]) => ({ name: n, parent: { name: g } })) },
      comments: { nodes: (o.comments ?? old?.comments.nodes.map((c: any) => c.body) ?? []).map((body: string) => ({ body })) },
      updatedAt: when.toISOString(),
    });
  };
  const shape = ({ updatedAt: _u, ...n }: any) => n;
  return {
    put,
    remove: (identifier: string) => issues.delete(identifier),
    whole: (): any[] => [...issues.values()].filter((n) => n.state.type !== "canceled").map(shape),
    changedAfter: (since: string): any[] => [...issues.values()].filter((n) => n.updatedAt > since).map(shape),
  };
}
type Linear = ReturnType<typeof fakeLinear>;

/** The task's export step, as the printed instructions ask for it: the whole snapshot, or the changes file with the `since` it was given. */
async function taskExports(linear: Linear, prompt: string): Promise<"whole" | "changes"> {
  const since = prompt.match(/updated after (\S+): give that time/)?.[1];
  await mkdir(relayDir(), { recursive: true });
  if (since) await writeFile(file("changes.json"), JSON.stringify({ v: 1, since, projectId: "proj-1", issues: linear.changedAfter(since) }));
  else await writeFile(file("snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", labels: pmxLabels(team), issues: linear.whole() }));
  return since ? "changes" : "whole";
}
/** One run of the sync task: its instructions, its export, and PMX's check. */
async function sync(linear: Linear, now: Date) {
  const prompt = await relayPrompt(team, now);
  const kind = await taskExports(linear, prompt);
  return { prompt, kind, said: (await checkRelay(team, now)).join("\n") };
}
const byId = (issues: any[]) => [...issues].sort((a, b) => a.identifier.localeCompare(b.identifier));

describe("a Linear sync with nothing to do is cheap (LINEAR-2, 0.41.0)", () => {
  beforeEach(freshHome);

  it("decides between the whole project and what changed, from the queue, the copy PMX has and the day", () => {
    const snapshot: Snapshot = { v: 1, syncedAt: at(9, 1).toISOString(), projectId: "proj-1", issues: [], labels: pmxLabels(team) };
    const record: SyncRecord = { v: 1, fullAt: at(8).toISOString(), through: at(9).toISOString(), run: null };
    const plan = (o: Partial<Parameters<typeof syncPlan>[0]> = {}) => syncPlan({ team, ops: [], snapshot, record, now: at(10), ...o });
    // Nothing queued, a copy from today: only what changed since the last sync started, less ten minutes.
    expect(plan()).toEqual({ mode: "changes", since: at(8, 50).toISOString() });
    // A shared skill document touches no issue and no label.
    expect(plan({ ops: [{ kind: "upsert-skill-doc" }] }).mode).toBe("changes");
    // A change to an issue wants the whole project and the label check, as before.
    for (const kind of ["create-task", "set-status", "set-label", "comment", "rewrite", "lodge-meeting"] as const) expect(plan({ ops: [{ kind }] })).toMatchObject({ mode: "full", why: "PMX has changes for Linear's issues" });
    // A Mac's first sync, and its first on 0.41.0 (a snapshot, but no record of a whole export).
    expect(plan({ snapshot: null })).toMatchObject({ mode: "full", why: "this Mac has no copy of the project yet" });
    expect(plan({ record: null }).mode).toBe("full");
    expect(plan({ record: { ...record, fullAt: null } }).mode).toBe("full");
    // Once a day: the first sync of the next day, whatever the hour of the last whole export.
    expect(plan({ now: at(23, 59) }).mode).toBe("changes");
    expect(plan({ now: at(0, 0, 21) })).toMatchObject({ mode: "full", why: "it's the day's first sync" });
    // A PMX label the last check didn't find (a new kind of work in the team's settings), or a copy that never listed them.
    expect(plan({ team: { ...team, categories: { ...team.categories, "pricing-memo": { skill: "pricing-memo" } } } as TeamConfig })).toMatchObject({ mode: "full", why: expect.stringMatching(/label/) });
    expect(plan({ snapshot: { ...snapshot, labels: undefined } }).mode).toBe("full");
    // Another project's copy, or a clock that went back.
    expect(plan({ snapshot: { ...snapshot, projectId: "proj-2" } }).mode).toBe("full");
    expect(plan({ now: at(7) }).mode).toBe("full");
  });

  it("exports the whole project first, then only what changed, and the whole project again the next day", async () => {
    const linear = fakeLinear();
    linear.put("PMX-1", at(7));
    linear.put("PMX-2", at(7), { labels: [["pmx-kind", "meeting"], ["pmx-status", "done"]] });

    // 08:00, this Mac's first sync: labels, then the whole project, in the instructions PMX always printed.
    const first = await sync(linear, at(8));
    expect(first.kind).toBe("whole");
    expect(first.prompt).toMatch(/## 0\. Make sure PMX's labels exist\n/);
    expect(first.prompt).toMatch(/## 2\. Export the project for PMX\nWrite .*snapshot\.json/);
    expect(first.said).toMatch(/^Snapshot: 2 item\(s\) from Linear/m);
    expect(await readSyncRecord()).toEqual({ v: 1, fullAt: at(8).toISOString(), through: at(8).toISOString(), run: null });

    // 09:00, nothing queued: no label check, no export of the project. One listing, with a time, and a small file.
    const idle = await relayPrompt(team, at(9));
    const since = at(7, 50).toISOString();
    expect(idle).not.toMatch(/Make sure PMX's labels exist|Export the project for PMX/);
    expect(idle).toMatch(/## 1\. Apply PMX's changes\nThere are no changes to apply\. Skip to step 2\./);
    expect(idle).toContain(`## 2. Export what changed since the last sync\nPMX has this project as of its last sync, so this run brings back only what changed. List the issues in project proj-1 that were updated after ${since}: give that time to the issue listing as its updated-after filter (\`updatedAt\`)`);
    expect(idle).toMatch(/Don't list the rest of the project, and don't check or create labels in this run\./);
    expect(idle).toContain(`Write ${file("changes.json")} with your file-writing tool`);
    expect(idle).toContain(`{"v": 1, "since": "${since}", "projectId": "proj-1", "issues": [`);
    expect(idle).toContain(`]}\nWith no issue to write, the rest of this step doesn't apply: don't look up labels or anything else. The connector may list labels by name only`);
    expect(idle).toContain(`Don't write or change ${file("snapshot.json")}: PMX merges these changes into it.`);
    expect(idle).toContain(`For every Linear document updated after ${since} in project proj-1 whose title starts with \`pmx-skill:\``);
    expect(idle).toMatch(/Never change any other issue, project or team, and never delete anything\./);
    expect(idle).toMatch(/## 4\. Finish\nRun `pmx linear relay --check`/);
    expect(await readSyncRecord()).toMatchObject({ run: { mode: "changes", startedAt: at(9).toISOString(), since } });

    // Nothing changed in Linear: the task writes an empty list, and PMX's copy is the same project, synced now.
    const before = (await readSnapshot())!;
    expect(await taskExports(linear, idle)).toBe("changes");
    const said = (await checkRelay(team, at(9))).join("\n");
    expect(said).toMatch(/^Applied 0 change\(s\) in Linear; 0 still waiting\.\nChanges: 0 issue\(s\) changed in Linear since the last sync\.\nSnapshot: 2 item\(s\) from Linear, synced /);
    const after = (await readSnapshot())!;
    expect(after.issues).toEqual(before.issues);
    expect(Object.keys(after).sort()).toEqual(["issues", "labels", "projectId", "syncedAt", "v"]);
    expect(Date.parse(after.syncedAt)).toBeGreaterThanOrEqual(Date.parse(before.syncedAt));
    expect(await readSyncRecord()).toEqual({ v: 1, fullAt: at(8).toISOString(), through: at(9).toISOString(), run: null });
    expect(await exists(file("changes.json"))).toBe(false);
    expect(await exists(file("snapshot.base.json"))).toBe(false);
    expect((await relayHealth(team, new Date(), { cron: "0 * * * *" })).ok).toBe(true);
    expect((await relayTracker(team).list()).map((t) => t.identifier)).toEqual(["PMX-1"]);

    // The rest of the day stays on changes; the first sync of the next day exports the whole project again.
    expect((await sync(linear, at(23))).kind).toBe("changes");
    const nextDay = await sync(linear, at(0, 0, 21));
    expect(nextDay.kind).toBe("whole");
    expect(nextDay.prompt).toBe(first.prompt);
    expect(await readSyncRecord()).toMatchObject({ fullAt: at(0, 0, 21).toISOString(), through: at(0, 0, 21).toISOString() });
    expect((await sync(linear, at(1, 0, 21))).kind).toBe("changes");
  });

  it("merging what changed gives the same copy as exporting the whole project", async () => {
    const linear = fakeLinear();
    linear.put("PMX-1", at(7), { description: "First draft" });
    linear.put("PMX-2", at(7), { labels: [["pmx-status", "inbox"], ["pmx-size", "M"]] });
    linear.put("PMX-3", at(7));
    linear.put("PMX-4", at(7), { labels: [["pmx-kind", "meeting"], ["pmx-status", "running"]] });
    await sync(linear, at(8));

    // In Linear, between syncs: a teammate edits one task and moves another to Ready, a third is canceled, a meeting
    // marker is finished with a comment, and a new task appears.
    linear.put("PMX-1", at(8, 20), { title: "Renamed by a teammate", description: "Second draft\npmx:note checked the numbers" });
    linear.put("PMX-2", at(8, 30), { labels: [["pmx-status", "ready"], ["pmx-size", "L"]] });
    linear.put("PMX-3", at(8, 40), { state: "Canceled" });
    linear.put("PMX-4", at(8, 45), { labels: [["pmx-kind", "meeting"], ["pmx-status", "done"]], comments: ["pmx:pr https://git.example/pr/7"] });
    linear.put("PMX-5", at(8, 50), { labels: [["pmx-status", "inbox"], ["pmx-category", "spec"]] });

    const run = await sync(linear, at(9));
    expect(run.kind).toBe("changes");
    expect(run.said).toMatch(/^Changes: 5 issue\(s\) changed in Linear since the last sync, merged into PMX's copy\.$/m);
    const merged = (await readSnapshot())!;
    // What a whole export at this moment would have written, issue for issue and field for field.
    expect(byId(merged.issues)).toEqual(byId(linear.whole()));
    expect(merged.issues.map((n) => n.identifier)).toEqual(["PMX-1", "PMX-2", "PMX-4", "PMX-5"]);
    expect({ v: merged.v, projectId: merged.projectId, labels: merged.labels }).toEqual({ v: 1, projectId: "proj-1", labels: pmxLabels(team) });
    // And PMX reads it as it reads any snapshot.
    const t = relayTracker(team, () => {}, () => new Date());
    expect((await t.list()).map((x) => [x.identifier, x.title, x.status])).toEqual([["PMX-1", "Renamed by a teammate", "ready"], ["PMX-2", "Task PMX-2", "ready"], ["PMX-5", "Task PMX-5", "inbox"]]);
    expect((await t.listMeetings()).map((m) => [m.identifier, m.status])).toEqual([["PMX-4", "done"]]);

    // The same merge, by itself: the copy it's given is left as it was, and an issue listed twice counts once.
    const base: Snapshot = { v: 1, syncedAt: "a", projectId: "proj-1", labels: ["pmx-status/ready"], issues: [{ id: "1", identifier: "PMX-1", title: "old" }, { id: "2", identifier: "PMX-2", title: "kept" }] };
    const out = mergeChanges(base, [{ id: "1", identifier: "PMX-1", title: "new" }, { id: "3", identifier: "PMX-3", title: "added" }, { id: "3", identifier: "PMX-3", title: "added, latest" }, { id: "4", identifier: "PMX-4", title: "never seen", state: { type: "canceled" } }], "b");
    expect(out).toEqual({ v: 1, syncedAt: "b", projectId: "proj-1", labels: ["pmx-status/ready"], issues: [{ id: "1", identifier: "PMX-1", title: "new" }, { id: "2", identifier: "PMX-2", title: "kept" }, { id: "3", identifier: "PMX-3", title: "added, latest" }] });
    expect(base.issues[0].title).toBe("old");

    // An issue deleted in Linear shows in no listing of changes: it leaves PMX's copy at the day's whole export.
    linear.remove("PMX-2");
    expect((await sync(linear, at(10))).kind).toBe("changes");
    expect((await readSnapshot())!.issues.map((n) => n.identifier)).toContain("PMX-2");
    expect((await sync(linear, at(0, 0, 21))).kind).toBe("whole");
    expect((await readSnapshot())!.issues.map((n) => n.identifier)).toEqual(["PMX-1", "PMX-4", "PMX-5"]);
  });

  it("a queued change to an issue brings the whole export and the label check back for that run", async () => {
    const linear = fakeLinear();
    linear.put("PMX-1", at(7));
    await sync(linear, at(8));
    expect((await sync(linear, at(9))).kind).toBe("changes");

    await relayTracker(team, () => {}, () => at(9, 30)).setStatus("PMX-1", "claimed");
    const prompt = await relayPrompt(team, at(10));
    expect(prompt).toMatch(/## 0\. Make sure PMX's labels exist/);
    expect(prompt).toContain(`Read ${file("outbox.json")}. Apply each operation`);
    expect(prompt).toMatch(/## 2\. Export the project for PMX/);
    // The task applies it and exports the project; the next idle run is cheap again.
    const [op] = (await readOutbox()).ops;
    linear.put("PMX-1", at(10), { labels: [["pmx-status", "claimed"]] });
    await writeFile(file("results.json"), JSON.stringify([{ id: op!.id, ok: true, identifier: "PMX-1", issueId: "uuid-PMX-1" }]));
    expect(await taskExports(linear, prompt)).toBe("whole");
    expect((await checkRelay(team, at(10))).join("\n")).toMatch(/^Applied 1 change\(s\) in Linear; 0 still waiting\./);
    expect((await sync(linear, at(11))).kind).toBe("changes");

    // A shared skill document is no issue: it is applied in a changes-only run, with the instructions for it.
    await enqueueSkillDoc("launch-brief", "# Launch brief\nSteps.", () => at(11, 30));
    const skill = await relayPrompt(team, at(12));
    expect(skill).toMatch(/`upsert-skill-doc`: create or update a Linear document/);
    expect(skill).toMatch(/## 2\. Export what changed since the last sync/);
    expect(skill).not.toMatch(/Make sure PMX's labels exist/);
  });

  it("keeps its copy, and asks for the whole project next, when a changes-only run goes wrong", async () => {
    const linear = fakeLinear();
    linear.put("PMX-1", at(7));
    linear.put("PMX-2", at(7));
    await sync(linear, at(8));
    const good = (await readSnapshot())!;
    const badRun = async (now: Date, write: (since: string) => Promise<void>) => {
      const prompt = await relayPrompt(team, now);
      const since = prompt.match(/updated after (\S+): give that time/)?.[1];
      expect(since, "a changes-only run").toBeTruthy();
      await write(since!);
      const said = (await checkRelay(team, now)).join("\n");
      expect(await readSnapshot()).toEqual(good);
      expect(await readSyncRecord()).toMatchObject({ fullAt: null, run: null });
      expect(await exists(file("changes.json"))).toBe(false);
      // The next sync exports the whole project, and the one after is cheap again.
      expect((await sync(linear, new Date(now.getTime() + 3600000))).kind).toBe("whole");
      return said;
    };

    // The task wrote nothing.
    expect(await badRun(at(9), async () => {})).toMatch(/⚠ This run was to bring back only what changed, but no changes file was written\. PMX kept its copy of Linear as of .*; the next sync exports the whole project\./);
    // It wrote the snapshot itself, with just the issue that changed: PMX's own copy comes back.
    const good2 = (await readSnapshot())!;
    Object.assign(good, good2);
    expect(await badRun(at(11), async () => { await writeFile(file("snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [linear.whole()[0]] })); }))
      .toMatch(/no changes file was written/);
    // A file from another run, one for another project, and one in the wrong shape.
    Object.assign(good, (await readSnapshot())!);
    expect(await badRun(at(13), async () => { await writeFile(file("changes.json"), JSON.stringify({ v: 1, since: "2026-11-01T00:00:00.000Z", projectId: "proj-1", issues: [] })); })).toMatch(/the changes file is for another run/);
    Object.assign(good, (await readSnapshot())!);
    expect(await badRun(at(15), async (since) => { await writeFile(file("changes.json"), JSON.stringify({ v: 1, since, projectId: "someone-elses", issues: [] })); })).toMatch(/the changes are for project someone-elses, not proj-1/);
    Object.assign(good, (await readSnapshot())!);
    expect(await badRun(at(17), async (since) => { await writeFile(file("changes.json"), JSON.stringify({ v: 1, since, projectId: "proj-1", issues: [{ identifier: "PMX-9" }] })); })).toMatch(/changed issue PMX-9 is missing id, identifier, title or labels/);
    Object.assign(good, (await readSnapshot())!);
    expect(await badRun(at(19), async () => { await writeFile(file("changes.json"), "{ not json"); })).toMatch(/the changes file isn't valid JSON/);

    // A whole-export run that wrote no new snapshot says so, and the next run asks for the whole project again.
    await relayPrompt(team, at(0, 0, 21));
    expect((await checkRelay(team, at(0, 0, 21))).join("\n")).toMatch(/⚠ This run wrote no new snapshot, so PMX's copy of Linear is as it was\. The next sync exports the whole project again\./);
    expect((await sync(linear, at(1, 0, 21))).kind).toBe("whole");
    // A second check in the same run finds nothing to take in, and changes nothing.
    const record = await readSyncRecord();
    expect((await checkRelay(team, at(1, 5, 21))).join("\n")).toMatch(/^Applied 0 change\(s\) in Linear; 0 still waiting\.\nSnapshot: 2 item\(s\) from Linear/);
    expect(await readSyncRecord()).toEqual(record);
  });

  it("a Mac updated from before 0.41.0 exports the whole project once, then syncs by changes", async () => {
    // Its snapshot is from an older PMX: no record of a whole export beside it.
    const linear = fakeLinear();
    linear.put("PMX-1", at(7));
    await mkdir(relayDir(), { recursive: true });
    await writeFile(file("snapshot.json"), JSON.stringify({ v: 1, syncedAt: at(7).toISOString(), projectId: "proj-1", labels: pmxLabels(team), issues: linear.whole() }));
    expect((await sync(linear, at(8))).kind).toBe("whole");
    expect((await sync(linear, at(9))).kind).toBe("changes");
  });
});

describe("the tasks in the Claude app are as 0.40.3 left them (CLAUDE-6, LINEAR-2)", () => {
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("claude-home-"); });

  it("nothing in 0.41.0 asks for /pmx-schedule again: each task's schedule, description and prompt are unchanged", async () => {
    // The sync task only asks pmx for its instructions, so the cheaper sync and the new default reach a Mac with the update.
    expect(LINEAR_SYNC_TASK.prompt).toMatch(/^1\. Run `pmx linear relay --prompt` in a shell\. It prints this run's exact instructions/m);
    expect(LINEAR_SYNC_TASK.prompt).not.toMatch(/snapshot\.json|changes\.json|pmx-status/);
    const pin = (t: typeof COLLECT_TASK) => createHash("sha256").update(`${t.cron}\n${taskDescription(t)}\n${t.prompt}`).digest("hex");
    // Cron, description and prompt of each task as released in 0.40.3. If one of these must change, the checklist's
    // `claude.tasks` step asks for /pmx-schedule by itself (taskState: "outdated"); say so in the changelog.
    expect(pin(COLLECT_TASK)).toBe("da54d1803edb69f6705bfb103e22f44f3b5822d73526f6aa23b1091463940d36");
    expect(pin(LINEAR_SYNC_TASK)).toBe("9113190bb4abfa23fd37fb8cf18a86eb0a28ff8b4884c0e50ba1b83b0e911378");
    expect([COLLECT_TASK.cron, LINEAR_SYNC_TASK.cron]).toEqual(["30 12,17 * * *", "0 * * * *"]);
    for (const t of [COLLECT_TASK, LINEAR_SYNC_TASK]) {
      await mkdir(join(taskFile(t.id), ".."), { recursive: true });
      await writeFile(taskFile(t.id), `---\nname: ${t.id}\ndescription: ${taskDescription(t)}\n---\n\n${t.prompt}\n`);
      expect(await taskState(t)).toBe("current");
    }
    expect(await readFile(taskFile(LINEAR_SYNC_TASK.id), "utf8")).toContain("pmx linear relay --prompt");
  });
});
