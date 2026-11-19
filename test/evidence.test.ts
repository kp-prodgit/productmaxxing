// Bridge 2 of joining PMX and PMX Engine (EQ-34): `pmx evidence --json` gives the head of product's studio counts
// only. Its shape is exactly what PMX Engine's `pmxe propose` accepts: format 1, kind pmx-evidence, and rows of
// by, label, tasks, sources, first and last. Nothing else, so no title, description, quote or meeting can travel.
import { describe, expect, it } from "vitest";
import type { Task } from "../src/core/types.js";
import { evidenceOf } from "../src/synth/evidence.js";

const task = (o: Partial<Task>): Task => ({
  id: o.title ?? "t", identifier: "PMX-1", title: "Secret customer quote in a title", description: "Jane said: we export a CSV\\npmx:source T1", url: "", category: "spec",
  size: "M", status: "inbox", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-10-01T10:00:00Z", ...o,
});

describe("pmx evidence (bridge 2)", () => {
  it("counts approved tasks per category and per roadmap theme, with sources and first and last day", () => {
    const e = evidenceOf([
      task({ category: "spec", theme: "Field capture", sources: ["T1", "T2"], createdAt: "2026-09-02T09:00:00Z" }),
      task({ category: "spec", theme: "Field capture", sources: ["S4"], createdAt: "2026-11-12T09:00:00Z" }),
      task({ category: "research-synthesis", sources: ["T3"], createdAt: "2026-10-05T09:00:00Z" }),
      task({ category: "spec", createdAt: "" }),
    ], "Acme", new Date("2026-11-18T10:00:00Z"));
    expect(e).toEqual({ format: 1, kind: "pmx-evidence", team: "Acme", at: "2026-11-18T10:00:00.000Z", rows: [
      { by: "theme", label: "Field capture", tasks: 2, sources: 3, first: "2026-09-02", last: "2026-11-12" },
      { by: "category", label: "spec", tasks: 2, sources: 3, first: "2026-09-02", last: "2026-11-12" },
      { by: "category", label: "research-synthesis", tasks: 1, sources: 1, first: "2026-10-05", last: "2026-10-05" },
    ] });
  });

  it("holds exactly the fields PMX Engine accepts, and no task's words", () => {
    const e = evidenceOf([task({ theme: "Field capture" })], "Acme", new Date());
    expect(Object.keys(e).sort()).toEqual(["at", "format", "kind", "rows", "team"]);
    for (const r of e.rows) expect(Object.keys(r).sort()).toEqual(["by", "first", "label", "last", "sources", "tasks"]);
    // The counts and the team's name: the timestamp is left out, since "2026-11-18T10:00" holds "T1" for an hour each day.
    expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const text = JSON.stringify({ ...e, at: "" });
    for (const secret of ["Secret customer quote", "Jane", "CSV", "T1", "PMX-1"]) expect(text).not.toContain(secret);
  });
});
