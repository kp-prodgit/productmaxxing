// Bridge 2 of joining PMX and PMX Engine (EQ-34, OUT-6): `pmx evidence --json` gives the head of product's studio
// counts only. Its shape is exactly what PMX Engine's `pmxe propose` accepts: kind pmx-evidence, and rows of by, label,
// tasks, sources, first and last. Nothing else, so no title, description, quote or meeting can travel. Format 2 counts
// each task once (its theme, else its kind of work), so the studio can add the rows up; format 1 is the older output.
import { describe, expect, it } from "vitest";
import type { Task } from "../src/core/types.js";
import { evidenceOf, formatEvidence } from "../src/synth/evidence.js";

const task = (o: Partial<Task>): Task => ({
  id: o.title ?? "t", identifier: "PMX-1", title: "Secret customer quote in a title", description: "Jane said: we export a CSV\\npmx:source T1", url: "", category: "spec",
  size: "M", status: "inbox", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-10-01T10:00:00Z", ...o,
});

// Eleven approved tasks: five with a roadmap theme, six without, across three kinds of work. One has no date.
const MIX: Task[] = [
  task({ category: "spec", theme: "Field capture", sources: ["T1", "T2"], createdAt: "2026-09-02T09:00:00Z" }),
  task({ category: "spec", theme: "Field capture", sources: ["S4"], createdAt: "2026-11-12T09:00:00Z" }),
  task({ category: "research-synthesis", theme: "Field capture", sources: ["T5"], createdAt: "2026-10-20T09:00:00Z" }),
  task({ category: "spec", theme: "Audit trail", sources: ["T6"], createdAt: "2026-10-03T09:00:00Z" }),
  task({ category: "validation-plan", theme: "Audit trail", sources: ["T7", "T8"], createdAt: "2026-11-01T09:00:00Z" }),
  task({ category: "spec", sources: ["T9"], createdAt: "2026-10-07T09:00:00Z" }),
  task({ category: "spec", sources: ["T10", "T11"], createdAt: "2026-11-09T09:00:00Z" }),
  task({ category: "spec", sources: [], createdAt: "2026-11-15T09:00:00Z" }),
  task({ category: "research-synthesis", sources: ["T3"], createdAt: "2026-10-05T09:00:00Z" }),
  task({ category: "research-synthesis", sources: ["T12"], createdAt: "2026-10-25T09:00:00Z" }),
  task({ category: "validation-plan", sources: ["T13"], createdAt: "2026-11-18T09:00:00Z" }),
  task({ category: "spec", theme: "Field capture", createdAt: "" }),
];
const NOW = new Date("2026-11-18T10:00:00Z");

describe("pmx evidence (bridge 2)", () => {
  it("counts a themed task in its theme only, and the tasks with no theme by kind of work, so the rows never overlap", () => {
    const e = evidenceOf(MIX, "Acme", NOW);
    expect(e).toEqual({ format: 2, kind: "pmx-evidence", team: "Acme", at: "2026-11-18T10:00:00.000Z", rows: [
      { by: "theme", label: "Field capture", tasks: 3, sources: 4, first: "2026-09-02", last: "2026-11-12" },
      { by: "theme", label: "Audit trail", tasks: 2, sources: 3, first: "2026-10-03", last: "2026-11-01" },
      { by: "category", label: "spec", tasks: 3, sources: 3, first: "2026-10-07", last: "2026-11-15" },
      { by: "category", label: "research-synthesis", tasks: 2, sources: 2, first: "2026-10-05", last: "2026-10-25" },
      { by: "category", label: "validation-plan", tasks: 1, sources: 1, first: "2026-11-18", last: "2026-11-18" },
    ] });
    // Every dated task is in exactly one row: the rows add up to the tasks, and their sources to the tasks' sources.
    const dated = MIX.filter((t) => t.createdAt);
    expect(e.rows.reduce((n, r) => n + r.tasks, 0)).toBe(dated.length);
    expect(e.rows.reduce((n, r) => n + r.sources, 0)).toBe(dated.reduce((n, t) => n + t.sources.length, 0));
  });

  it("gives PMX Engine 0.14 and earlier the older counts with --format 1: every task by kind of work, themed ones again", () => {
    const e = evidenceOf(MIX, "Acme", NOW, 1);
    expect(e.format).toBe(1);
    expect(e.rows).toEqual([
      { by: "theme", label: "Field capture", tasks: 3, sources: 4, first: "2026-09-02", last: "2026-11-12" },
      { by: "theme", label: "Audit trail", tasks: 2, sources: 3, first: "2026-10-03", last: "2026-11-01" },
      { by: "category", label: "spec", tasks: 6, sources: 7, first: "2026-09-02", last: "2026-11-15" },
      { by: "category", label: "research-synthesis", tasks: 3, sources: 3, first: "2026-10-05", last: "2026-10-25" },
      { by: "category", label: "validation-plan", tasks: 2, sources: 3, first: "2026-11-01", last: "2026-11-18" },
    ]);
  });

  it("with no themed tasks, format 2 has the same category rows as format 1", () => {
    const plain = MIX.filter((t) => !t.theme);
    expect(evidenceOf(plain, "Acme", NOW).rows).toEqual(evidenceOf(plain, "Acme", NOW, 1).rows);
  });

  it("says in Terminal what each row counts, and how many tasks there are in all", () => {
    const text = formatEvidence(evidenceOf(MIX, "Acme", NOW));
    expect(text).toContain("theme  Field capture: 3 tasks, 4 sources, 2026-09-02 to 2026-11-12");
    expect(text).toContain("kind of work, no theme  validation-plan: 1 task, 1 source, 2026-11-18 to 2026-11-18");
    expect(text).toContain("11 approved tasks, each counted once: 5 under a roadmap theme, 6 by kind of work.");
    expect(text).toContain("pmx evidence --json | pmxe propose -");
    expect(text).toContain("pmx evidence --json --format 1 | pmxe propose -");
    expect(formatEvidence(evidenceOf(MIX, "Acme", NOW, 1))).toContain("kind of work  spec: 6 tasks");
    expect(formatEvidence(evidenceOf([], "Acme", NOW))).toBe("No approved tasks yet.");
  });

  it("holds exactly the fields PMX Engine accepts, and no task's words", () => {
    for (const format of [1, 2] as const) {
      const e = evidenceOf([task({ theme: "Field capture" }), task({ category: "research-synthesis" })], "Acme", new Date(), format);
      expect(Object.keys(e).sort()).toEqual(["at", "format", "kind", "rows", "team"]);
      for (const r of e.rows) expect(Object.keys(r).sort()).toEqual(["by", "first", "label", "last", "sources", "tasks"]);
      // The counts and the team's name: the timestamp is left out, since "2026-11-18T10:00" holds "T1" for an hour each day.
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const text = JSON.stringify({ ...e, at: "" });
      for (const secret of ["Secret customer quote", "Jane", "CSV", "T1", "PMX-1"]) expect(text).not.toContain(secret);
    }
  });
});
