import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { meetingCommands } from "../src/commands/meetings.js";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { localDay } from "../src/meetings/ledger.js";
import { formatTodos, TODO_DAYS, todoPeriod, todosInPeriod } from "../src/todo/todo.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

// Local time, so day boundaries match the PM's own calendar on any test machine.
const NOW = new Date(2026, 10, 12, 15, 0, 0);
const todo = (id: string, at: string, status: "open" | "done" = "open") => ({
  id, text: `to-do ${id}`, due: null, why: "", source: { title: "Call", at, keys: [] }, status, createdAt: `${at}T10:00:00Z`, doneAt: null, receiptId: "r",
}) as any;

describe("pmx todo picks a time period, the last 7 days by default (TODO-4)", () => {
  it("defaults to the last 7 days, the same window refresh reads", () => {
    const p = todoPeriod({}, NOW);
    expect(TODO_DAYS).toBe(7);
    expect(localDay(p.since)).toBe("2026-11-05");
    expect(p).toMatchObject({ days: 7, label: "the last 7 days", chosen: false });
  });

  it("takes --days N, --since Nd, --since today and --since a date", () => {
    expect(localDay(todoPeriod({ days: "30" }, NOW).since)).toBe("2026-10-13");
    expect(todoPeriod({ days: "1" }, NOW).label).toBe("the last 1 day");
    expect(localDay(todoPeriod({ since: "14d" }, NOW).since)).toBe("2026-10-29");
    expect(todoPeriod({ since: "today" }, NOW)).toMatchObject({ days: 0, label: "today", chosen: true });
    expect(localDay(todoPeriod({ since: "today" }, NOW).since)).toBe("2026-11-12");
    expect(todoPeriod({ since: "2026-11-01" }, NOW)).toMatchObject({ days: 11, label: "since 2026-11-01" });
    expect(todoPeriod({ days: "all" }, NOW).days).toBe(Infinity);
  });

  it("refuses periods it can't use, saying what it takes", () => {
    expect(() => todoPeriod({ days: "7", since: "today" }, NOW)).toThrow(/not both/);
    expect(() => todoPeriod({ days: "0" }, NOW)).toThrow(/1 to 90 days/);
    expect(() => todoPeriod({ days: "91" }, NOW)).toThrow(/1 to 90 days/);
    expect(() => todoPeriod({ days: "a week" }, NOW)).toThrow(/1 to 90 days/);
    expect(() => todoPeriod({ since: "last week" }, NOW)).toThrow(/30d/);
    expect(() => todoPeriod({ since: "2026-11-20" }, NOW)).toThrow(/future/);
    expect(() => todoPeriod({ since: "2026-01-01" }, NOW)).toThrow(/more than 90 days/);
    expect(() => todoPeriod({ since: "2026-11-31" }, NOW)).toThrow(/isn't a real date/);
  });

  it("lists to-dos from meetings in the period and counts the older ones, with how far back they go", () => {
    const items = [todo("a", "2026-11-12"), todo("b", "2026-11-05"), todo("c", "2026-11-04"), todo("d", "2026-10-01")];
    const r = todosInPeriod(items, todoPeriod({}, NOW).since, NOW);
    expect(r.shown.map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.older).toBe(2);
    expect(r.oldestDays).toBe(42);
    // The hint's --days really does bring the oldest one back.
    expect(todosInPeriod(items, todoPeriod({ days: String(r.oldestDays) }, NOW).since, NOW).older).toBe(0);
    expect(todosInPeriod(items, todoPeriod({ days: "all" }, NOW).since, NOW).shown).toHaveLength(4);
  });

  it("an empty period says which period and how to look further back", () => {
    expect(formatTodos([], "the last 7 days")).toMatch(/^No open to-dos from the last 7 days\. .*--days 30/);
  });

  it("`pmx todo` shows the last 7 days and says how to see older ones; --days widens it", async () => {
    const home = await freshHome();
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const items = [todo("a", "2026-11-11"), todo("b", "2026-10-20"), todo("c", "2026-11-10", "done")];
    await writeFile(join(home, "todos.json"), JSON.stringify({ v: 1, processed: {}, items }));
    const cmd = meetingCommands.find((c) => c.name === "todo")!;
    const run = async (values: Record<string, unknown>) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try { await cmd.run({ ctx: async () => ctx, values, positionals: [], ask: {} } as any); return log.mock.calls.map((c) => c.join(" ")).join("\n"); }
      finally { log.mockRestore(); }
    };
    const out = await run({});
    expect(out).toMatch(/To-dos from the last 7 days:/);
    expect(out).toMatch(/to-do a/);
    expect(out).not.toMatch(/to-do b|to-do c/);
    expect(out).toMatch(/1 open to-do\(s\) from before that\. See them with: pmx todo --days 23/);
    const wide = await run({ days: "23" });
    expect(wide).toMatch(/to-do b/);
    expect(wide).not.toMatch(/before that/);
    expect(await run({ days: "all", all: true })).toMatch(/to-do c/);
    expect(JSON.parse(await run({ json: true })).map((t: any) => t.id)).toEqual(["a"]);
    await expect(run({ refresh: true, days: "all" })).rejects.toThrow(/at most 90 days/);
  });

  it("the board's to-do views have the same picker, the last 7 days by default, and say what it hides", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    expect(page).toContain('["7", "Last 7 days"]');
    expect(page).toMatch(/store\.get\("pmx-todo-days"\);[^\n]*: "7"/);
    for (const view of ["Today", "Upcoming", "Anytime"]) expect(page).toMatch(new RegExp(`head\\([^\\n]*"${view}",[^\\n]*\\[periodSelect\\(\\)\\]\\)`));
    expect(page).toContain("from earlier meetings");
  });
});
