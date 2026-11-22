// BOARD-12: one vocabulary, shared with PMX Engine. What a PM reads says task, backlog, draft, run, page, release and
// audience. Command names, flags, ids, JSON fields, file names and Linear label names keep their names (`pmx
// proposals`, `pmx tick`, proposals.json, pmx-status: inbox), so this checks the words people read, never the code.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { tickHealth } from "../src/commands/tick.js";
import { buildChecklist, recordChecklist } from "../src/setup/checklist.js";
import { approvedText, formatProposals, stageProposals, START_OFF } from "../src/synth/proposals.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";
import type { Ctx } from "../src/core/context.js";

/** The words the founder retired on 2026-11-21, as a PM would read them. "pull request" and a check that passes stay. */
const OLD = /\b(proposals?|proposed|proposes|proposing|pool|hubs?|issues?|signals?|passes|(?:last|next|this|a|no|its|one|per) pass)\b/i;

const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
const H = 3600000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const node = (n: number, status: string, title: string) => ({
  id: `uuid-${n}`, identifier: `PMX-${n}`, title, description: "", url: `https://linear.app/team/issue/PMX-${n}`, priority: 0,
  createdAt: ago(3 * 24 * H), comments: { nodes: [] },
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "S", parent: { name: "pmx-size" } }] },
});

/** A task waiting for approval, tasks in the backlog, Ready and in review, and a checklist with work in it. */
async function work(ctx: Ctx) {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [
    node(30, "inbox", "Pricing page copy"), node(31, "ready", "Spec the export"), node(32, "review", "Spec the audit log"),
  ] }));
  await stageProposals([{ at: ago(2 * 24 * H), receipt: "r0", title: "Export approval history to CSV", description: "Admins need a record.", category: "spec", size: "M", sources: ["T1"], from: [{ id: "T1", title: "Beta call", at: ago(2 * 24 * H).slice(0, 10), why: "asked twice" }] }]);
  await recordChecklist(buildChecklist({
    now: new Date(), version: "0.35.0", personal: ctx.personal, team: { ...DEFAULT_TEAM, tracker: LINEAR } as any,
    checks: [], state: { lastTick: { at: ago(H / 2), failed: [], failStreak: 0 }, collectReports: [] } as any, claude: true, hasRemote: false, memoryFilled: true,
    proposals: 1, tasks: { pool: 1, ready: 1, blocked: 0 }, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
  }));
}

describe("one vocabulary (BOARD-12)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const startNow of [true, false]) it(`the page says task, backlog and run in every view${startNow ? "" : " (Start now off)"}`, async () => {
    ui = await openBoard({ hash: "needs", team: { tracker: LINEAR as any, approve: { startNow } } as any, before: work });
    await ui.until(() => ui!.$("main section.group"), "Needs you");
    const seen: string[] = [];
    for (const hash of ["needs", "work", "work/agents", "work/digest", "health", "health/running", "health/setup", "health/activity", "health/steps", "health/flow",
      ...["sources", "customers", "dnr", "private", "linear", "schedule", "digestset", "kinds", "newkind", "sizes", "limits", "account"].map((s) => `health/settings/${s}`)]) {
      await ui.go(`#${hash}`);
      await ui.until(() => ui!.$("main h1"), hash);
      const text = pageText(ui);
      const hit = OLD.exec(text);
      seen.push(`${hash}: ${hit ? `"${text.slice(Math.max(0, hit.index - 60), hit.index + 40)}"` : "ok"}`);
    }
    expect(seen.filter((s) => !s.endsWith(": ok"))).toEqual([]);
    // The words that replaced them are there.
    await ui.go("#work");
    await ui.until(() => ui!.$("main section.group[aria-label='In the backlog']"), "the backlog");
    expect(pageText(ui)).toMatch(/Backlog/);
  }, 60000);

  it("PMX's own output in Terminal and the checklist uses the same words", async () => {
    expect(formatProposals([])).toMatch(/^No new tasks are waiting\./);
    expect(START_OFF).toMatch(/waits in the backlog/);
    expect(approvedText([{ identifier: "PMX-1" }], { start: false, startNow: true })).toMatch(/in your team's backlog in Linear/);
    expect(tickHealth({ at: "2026-11-21T09:00:00Z", failed: ["spawn claude ENOENT"], failStreak: 3 })!.detail).toMatch(/failed 3 runs in a row/);
    await freshHome();
    const ctx = await testCtx({ repo: (await pmxRepo()).repo });
    const cl = buildChecklist({
      now: new Date("2026-11-21T10:00:00Z"), version: "0.35.0", personal: ctx.personal, team: { ...DEFAULT_TEAM, tracker: LINEAR } as any,
      checks: [], state: { lastTick: null, collectReports: [] } as any, claude: true, hasRemote: false, memoryFilled: true,
      proposals: 2, tasks: { pool: 3, ready: 0, blocked: 0 }, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
    });
    const words = JSON.stringify(cl, (k, v) => (["id", "do", "cmd", "command"].includes(k) ? undefined : v));
    expect(OLD.exec(words)?.[0] ?? null).toBeNull();
  });
});
