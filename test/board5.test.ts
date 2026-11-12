import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { paths } from "../src/core/paths.js";
import type { RunReceipt } from "../src/core/receipt.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { startExplainServer } from "../src/explain/server.js";
import { applyPersonal, checkChange } from "../src/flow/actions.js";
import { buildActivity, buildAutomations, type AutomationInputs } from "../src/flow/automations.js";
import { buildDigestBoard, digestAction, nextDigestDay } from "../src/flow/digests.js";
import { startJob } from "../src/flow/jobs.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { relayWords } from "../src/flow/pipeline-load.js";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { buildPipeline } from "../src/flow/pipeline.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

// Friday 2026-11-06, 15:00 local time: a digest day for a PM whose digest weekday is 5.
const NOW = new Date(2026, 10, 6, 15, 0, 0);
const iso = (d: number, h = 12) => new Date(2026, 10, d, h, 0, 0).toISOString();
const digestReceipt = (over: Partial<RunReceipt>): RunReceipt => ({
  v: 1, id: "digest-x", type: "digest", at: iso(6, 9), agent: "ana@m1", outcome: "staged",
  window: { days: 7, since: "", scope: "personal" }, rules: { internalDomains: [], requireExternalParticipant: true, topicRulesHash: "", neverIngest: { people: 0, channels: 0, meetingTitles: 0 }, folders: [] },
  skippedSources: [], masked: { email: 0, phone: 0, card: 0, id: 0, person: 0 }, skills: [], model: { name: "m", runtime: "r", tools: "", costUsd: 0.12, tokens: 1, durationMs: 1, promptSha256: "" },
  sources: [
    { kind: "transcript", refHash: "a", decision: "used", detail: "", passagesCut: [], title: "Acme renewal" } as any,
    { kind: "transcript", refHash: "b", decision: "left-out", rule: "one-on-one", detail: "", passagesCut: [] } as any,
  ],
  digest: { cited: ["T1"], removedClaims: 2, staged: "x" }, ...over,
});

function autoInputs(over: Partial<AutomationInputs> = {}): AutomationInputs {
  return {
    now: NOW, agent: "ana@m1", handle: "ana", installedAt: iso(1), jobInstalled: true, lastTick: { at: iso(6, 14), failed: [], failStreak: 0 }, tickOk: true,
    schedules: [{ name: "collect meetings and update to-dos", last: iso(6, 12), next: iso(6, 17), ok: true, detail: "", when: "weekdays 12:30 and 17:30", node: "collect" }],
    collectReports: [{ at: iso(6, 12), connector: "granola", saved: 2, skipped: { "never-ingest-title": 1 } }],
    receipts: [], runlog: [], tracker: true, synthesizer: "bo", company: null, lastSynthAt: null, lastRollupAt: null, lastEventSyncAt: null, analytics: false,
    autoUpdate: { on: true, state: null, version: "0.20.0" }, linear: { mode: "api", syncedAt: iso(6, 14), waiting: 0 },
    proposals: 2, drafts: 0, reviewCap: 3, todos: 1, paused: [], digest: null, pendingTeam: 0, killSwitch: { on: false, reason: null }, jobs: [], ...over,
  };
}

beforeEach(async () => {
  await freshHome();
});

describe("0.20.0: every interaction point on the board, in a PM's words (BOARD-5)", () => {
  it("the digest: what waits for approval, how each past week ended, and when the next one is built", () => {
    const runlog = [
      { type: "digest", ts: iso(2, 10), agent: "ana@m1", machine: "m1", outcome: "staged", items: 3, held: 0, durationMs: 1, tokens: 1, costUsd: 0.1 },
      { type: "digest", ts: iso(2, 11), agent: "ana@m1", machine: "m1", outcome: "approved", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null },
      { type: "digest", ts: iso(2, 11), agent: "bo@m2", machine: "m2", outcome: "rejected", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null },
    ] as RunLogEntry[];
    const base = {
      now: NOW, agent: "ana@m1", weekday: 5, lastDigestWeek: "2026-W45", runlog, prs: [{ week: "2026-W45", url: "https://github.com/o/r/pull/9", at: iso(2, 11) }],
      receipts: [digestReceipt({ at: iso(6, 9) }), digestReceipt({ id: "digest-old", at: iso(1, 9), outcome: "no-signal", sources: [] })],
      staged: [{ week: "2026-W45", at: iso(6, 9), markdown: "# Signal digest\n\n## Top themes\n\n- A theme [T1]" }],
      dmUser: "U0123ABCD", slackChannel: "C1", reads: ["Your customer calls from the last 7 days"],
    };
    const local = buildDigestBoard({ ...base, local: true });
    expect(local.waiting).toEqual([{ week: "2026-W45", at: iso(6, 9), sources: 1, held: 1, removedClaims: 2, markdown: expect.stringMatching(/A theme/) }]);
    // Approved on Monday, then rebuilt on Friday: the approval is history, the new build waits. A teammate's
    // rejection isn't this PM's history.
    expect(local.history.map((h) => [h.week, h.status, h.url])).toEqual([["2026-W45", "approved", "https://github.com/o/r/pull/9"], ["2026-W44", "no-signal", null]]);
    expect(local.dm).toEqual({ on: true, user: "U0123ABCD" });
    // The shared page in Claude gets counts and status only: no digest text, no Slack ID or channel.
    const shared = buildDigestBoard({ ...base, local: false });
    expect(shared.waiting[0]!.markdown).toBeNull();
    expect(shared.dm).toEqual({ on: true, user: null });
    expect(JSON.stringify(shared)).not.toMatch(/A theme|U0123ABCD|Acme/);
    // Already built this week: the next one is next Friday. Not built yet on a Friday: today.
    expect(nextDigestDay(NOW, 5, "2026-W45")).toBe("2026-11-13");
    expect(nextDigestDay(NOW, 5, "2026-W44")).toBe("2026-11-06");
    expect(nextDigestDay(NOW, 1, null)).toBe("2026-11-09");
  });

  it("approving, editing and rejecting a digest from the board does what pmx digest --review does", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    await mkdir(paths.staging(), { recursive: true });
    const file = join(paths.staging(), "digest-2026-W45.md");
    await writeFile(file, "# Signal digest · 2026-W45\n\n## Top themes\n\n- Pricing is unclear [T1]\n");
    expect((await digestAction(ctx, "approve", "W45", undefined)).status).toBe(400);
    expect((await digestAction(ctx, "approve", "2026-W44")).status).toBe(404);
    expect((await digestAction(ctx, "save", "2026-W45", "too short")).status).toBe(400);
    const saved = await digestAction(ctx, "save", "2026-W45", "# Signal digest · 2026-W45\n\n## Top themes\n\n- Pricing is unclear to buyers [T1]\n");
    expect(saved).toMatchObject({ status: 200, body: { message: expect.stringMatching(/still only on this Mac/) } });
    expect(await readFile(file, "utf8")).toMatch(/unclear to buyers/);
    const ok = await digestAction(ctx, "approve", "2026-W45");
    expect(ok).toMatchObject({ status: 200, body: { message: expect.stringMatching(/^Approved: committed on pmx\/digest\//) } });
    expect(await ctx.repo.ok(["show", `pmx/digest/${ctx.personal.handle}/2026-W45:digests/${ctx.personal.handle}/2026-W45.md`])).toMatch(/unclear to buyers/);
    await expect(readFile(file, "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(paths.home(), "digest-prs.json"), "utf8"))).toEqual([expect.objectContaining({ week: "2026-W45", url: expect.stringMatching(/^branch:/) })]);
    await writeFile(file, "# Signal digest · 2026-W45\n\n- Another [T1]\n");
    expect(await digestAction(ctx, "reject", "2026-W45")).toMatchObject({ status: 200, body: { message: expect.stringMatching(/Nothing reached your team's repo/) } });
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("each automated step has one status row; steps that wait on automatic runs say so once, with the fix on that row only", () => {
    const off = buildAutomations(autoInputs({ jobInstalled: false, lastTick: null }));
    const job = off.find((a) => a.id === "job")!;
    expect(job).toMatchObject({ status: "setup", statusText: "Off", fix: { action: "install-job", cmd: "pmx init" }, run: "tick" });
    expect(off.find((a) => a.id === "todo")).toMatchObject({ status: "off", statusText: "Waits for automatic runs", fix: null });
    expect(off.filter((a) => a.fix?.action === "install-job")).toHaveLength(1);

    const on = buildAutomations(autoInputs({ digest: { weekday: 5, week: "2026-W45", next: "2026-11-13", waiting: [{ week: "2026-W45", at: iso(6, 9), sources: 1, held: 0, removedClaims: 0, markdown: null }], history: [], dm: { on: false, user: null }, slackChannel: null, reads: [] } }));
    const ids = on.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["collect", "todo", "synthesize", "approve", "linear", "digest", "pull", "review", "autopause", "release", "job", "update", "events", "team-changes"]));
    expect(on.find((a) => a.id === "collect")).toMatchObject({ status: "ok", result: "2 meetings saved, 1 skipped", run: null, runNote: expect.stringMatching(/Claude app/) });
    // Synthesis runs on the team's synthesis Mac, so this Mac can't run it and says where it runs.
    expect(on.find((a) => a.id === "synthesize")).toMatchObject({ run: null, runNote: expect.stringMatching(/^Runs on bo/) });
    expect(on.find((a) => a.id === "approve")).toMatchObject({ by: "you", status: "waiting", statusText: "2 waiting for you" });
    expect(on.find((a) => a.id === "digest")).toMatchObject({ status: "waiting", statusText: "1 digest to read", next: "2026-11-13", tab: "digest" });
    // The first week after install, the agent only says what it would pick.
    expect(on.find((a) => a.id === "pull")).toMatchObject({ statusText: "Practice mode" });
    // Nothing on the board names a PMX command as the way to see a step's output.
    expect(JSON.stringify(on.map((a) => [a.what, a.statusText, a.result]))).not.toMatch(/pmx [a-z]/);

    const stopped = buildAutomations(autoInputs({ killSwitch: { on: true, reason: "incident" } }));
    expect(stopped.filter((a) => a.run)).toEqual([expect.objectContaining({ id: "update" })]);
    expect(stopped.find((a) => a.id === "job")).toMatchObject({ status: "off", fix: { text: expect.stringMatching(/emergency stop: incident/) } });
  });

  it("the activity feed says what happened in counts and task IDs, never meeting titles", () => {
    const a = buildActivity({
      now: NOW, hours: 168, agent: "ana@m1", lastTick: { at: iso(6, 14), failed: ["pull: failed: x"], failStreak: 1 },
      collectReports: [{ at: iso(6, 12), connector: "granola", saved: 2, skipped: { "never-ingest-person": 1 } }],
      receipts: [digestReceipt({ at: iso(6, 9) }), digestReceipt({ id: "t", type: "todo", at: iso(5, 9), todo: { added: [{ text: "Send pricing to Acme", source: "T1", due: null }], duplicates: 0, dropped: [] } })],
      runlog: [
        { type: "run", ts: iso(5, 10), agent: "ana@m1", machine: "m1", taskId: "PMX-4", category: "spec", size: "M", skill: "pmx-spec", skillVersion: "1", outcome: "ok", durationMs: 1, tokens: 1, costUsd: 1, runtime: "x" },
        { type: "verdict", ts: iso(5, 11), agent: "bo@m2", machine: "m2", taskId: "PMX-3", category: "spec", size: "S", verdict: "redo", reviewMinutes: 1, editSize: 0 },
      ] as RunLogEntry[],
    });
    expect(a.map((x) => x.text)).toEqual([
      "1 step of the background pass failed", "Collected 2 meetings from granola; 1 skipped by your do-not-read list", "Your digest for the week of Nov 2 was built: 1 source cited",
      "PMX-3 sent back for a redo by a teammate", "Your agent drafted PMX-4 (spec)", "Found 1 to-do in your meetings",
    ]);
    expect(JSON.stringify(a)).not.toMatch(/Acme|pricing/i);
  });

  it("the Linear row agrees with Today's warning, and the timeline knows which days a task runs", async () => {
    const { cronDays } = await import("../src/flow/pipeline-load.js");
    const behind = buildAutomations(autoInputs({ linear: { mode: "relay", syncedAt: iso(6, 0), waiting: 2, ok: false, problem: "Linear last synced 15 hours ago." },
      schedules: [{ name: "sync Linear through Claude", last: iso(6, 0), next: iso(9, 8), ok: true, detail: "", when: "hourly", node: "inbox" }] }));
    expect(behind.find((a) => a.id === "linear")).toMatchObject({ status: "attention", statusText: "Last synced 15 h ago", fix: { text: "Linear last synced 15 hours ago." } });
    expect(cronDays("1-5")).toEqual([1, 2, 3, 4, 5]);
    expect(cronDays("*")).toHaveLength(7);
    expect(cronDays("0,6")).toEqual([0, 6]);
  });

  it("the digest's day and Slack DM are personal settings the board can change", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    expect(() => checkChange({ kind: "digest-day", value: 9 }, ctx.team)).toThrow(/day of the week/);
    expect(() => checkChange({ kind: "digest-dm", value: "@ana" }, ctx.team)).toThrow(/member ID/);
    const ch = [checkChange({ kind: "digest-day", value: 1 }, ctx.team), checkChange({ kind: "digest-dm", value: "u0123abcd" }, ctx.team)];
    expect(await applyPersonal(ctx.personal, ch)).toEqual(["Build the digest on Mondays", "Send the approved digest to Slack member U0123ABCD"]);
    expect(ctx.personal.digest).toEqual({ weekday: 1, slackDmUserId: "U0123ABCD" });
    await applyPersonal(ctx.personal, [checkChange({ kind: "digest-dm", value: "" }, ctx.team)]);
    expect(ctx.personal.digest.slackDmUserId).toBeNull();
  });

  it("the Linear sync's problems are said without PMX's command names", () => {
    expect(relayWords("Linear through Claude: last synced 15h ago (2 change(s) waiting); run the \"PMX: sync Linear through Claude\" task in the Claude app (`pmx schedule` says whether it exists)", 2))
      .toEqual({ text: expect.stringMatching(/^Linear last synced 15 hours ago\. .* 2 changes are waiting to go to Linear\.$/), cmd: "/pmx-schedule" });
    expect(relayWords("Linear through Claude: not synced yet; run …", 0).text).toMatch(/type \/pmx-schedule there/);
    expect(relayWords("Linear through Claude: 3 PMX label(s) missing in Linear (a, b, c), so …", 0).text).not.toMatch(/pmx /);
  });

  it("the local server takes the new actions only with the token, and checks what it's sent", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: pipelineHandlers(ctx) });
    const token = new URL(s.flowUrl).hash.slice(3);
    const base = s.flowUrl.split("#")[0]!.replace(/\/flow$/, "");
    const post = (path: string, body: unknown, auth = `Bearer ${token}`) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post("/api/pipeline/run", { step: "digest" }, "Bearer nope")).status).toBe(403);
      expect((await post("/api/pipeline/run", { step: "rm -rf" })).status).toBe(400);
      expect((await post("/api/pipeline/todo", { id: "../x" })).status).toBe(400);
      expect((await post("/api/pipeline/todo", { id: "nope-123" })).status).toBe(404);
      expect((await post("/api/pipeline/digest", { action: "approve", week: "2026-W45" })).status).toBe(404);
      expect((await post("/api/pipeline/setup", { action: "format-disk" })).status).toBe(400);
    } finally {
      await s.close();
    }
    // A step already running isn't started twice.
    const first = startJob(ctx, "release");
    expect(first.status).toBe(202);
    expect(startJob(ctx, "release").status).toBe(409);
  });

  it("the shared page's data carries no digest text, no Slack ID and no Run now state", () => {
    const i: any = {
      level: "shared", now: NOW, hours: 168, agent: "ana@m1", receipts: [], runlog: [], issues: [], linearSyncedAt: null, collectReports: [], todosCreated: [], proposals: [],
      checks: [], health: { problems: [], facts: [] }, lastTick: null, skills: [], schedules: [],
      rules: { routes: {}, teamDomains: [], myDomains: [], neverIngest: { people: [], titles: [], channels: [] }, budget: { dailyUsd: null, teamCap: 20, spentUsd: 0, tokens: 0 }, categories: [], reviewCap: 3, sizes: { S: { minutes: 1, usd: 1 }, M: { minutes: 1, usd: 1 }, L: { minutes: 1, usd: 1 }, XL: { minutes: 1, usd: 1 } }, rubric: {}, slackChannels: [], allowedSources: [] },
      digest: { weekday: 5, week: "2026-W45", next: "2026-11-13", waiting: [{ week: "2026-W45", at: null, sources: 1, held: 0, removedClaims: 0, markdown: "secret theme" }], history: [], dm: { on: true, user: "U0123ABCD" }, slackChannel: "C1", reads: [] },
      jobs: [{ step: "digest", startedAt: "", finishedAt: null, ok: null, message: null }],
    };
    const d = buildPipeline(i);
    expect(JSON.stringify(d)).not.toMatch(/secret theme|U0123ABCD|"C1"/);
    expect(d.jobs).toEqual([]);
    expect(d.digest!.waiting[0]!.sources).toBe(1);
  });

  it("the page: Today first, every tab routed, old links land on their new home, and Terminal is never the first fix", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    // 0.23.0 (BOARD-6): a left nav of views instead of tabs, each with its own route, opening on Today.
    expect(page.startsWith("<title>PMX Workspace</title>")).toBe(true);
    expect(page).toMatch(/<script type="application\/json" id="pmx-config">/);
    expect(page).toMatch(/const VIEWS = \["inbox", "today", "upcoming", "anytime", "logbook", "plan", "digest", "agents", "status", "settings"\]/);
    for (const v of ["inbox", "today", "upcoming", "anytime", "logbook", "plan", "digest", "agents", "status", "settings"]) expect(page).toContain(`data-view="${v}"`);
    expect(page).toMatch(/const S = \{ view: "today"/);
    // Links from before 0.23.0 land on their new home.
    for (const old of ["flow", "automations", "sources", "privacy", "work"]) expect(page).toMatch(new RegExp(`[{ ]${old}: \\["`));
    // Completing or approving waits for Undo before anything is sent.
    expect(page).toMatch(/const GRACE = 4000;/);
    // No markup PMX's local policy would block, and no sample data.
    expect(page).not.toMatch(/style="|\son[a-z]+="|<script src=|<link /);
    expect(page).not.toMatch(/example data/i);
    // Commands sit behind a "Prefer Terminal?" disclosure; the visible control is a button.
    expect(page).toMatch(/const terminal = \(cmd, label = "Prefer Terminal\?"\)/);
    expect(page).not.toMatch(/cmdChip\(/);
    // Digest text is rendered as text nodes, never parsed as HTML.
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    // Motion respects the PM's setting.
    expect(page).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const js = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
    expect(() => new Function(js)).not.toThrow();
  });
});
