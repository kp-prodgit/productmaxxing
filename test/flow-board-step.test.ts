import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { relayDir } from "../src/tracker/relay.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
const issue = (n: number, status: string, category = "spec") => ({
  id: `uuid-${n}`, identifier: `PMX-${n}`, title: `Task ${n}`, description: "", url: "", priority: 0, createdAt: NOW.toISOString(), comments: { nodes: [] },
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: category, parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] },
});

describe("the team board on the Flow map (BOARD-7)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("puts the team board between the pool and Ready, with what's in each now", async () => {
    ui = await openBoard({
      hash: "flow", now: NOW, team: { tracker: LINEAR as any },
      before: async () => {
        await mkdir(relayDir(), { recursive: true });
        // Two team tasks in the pool, one Ready, and the PM's own to-do in Linear, which isn't team work.
        await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1",
          issues: [issue(1, "inbox"), issue(2, "inbox"), issue(3, "ready"), issue(4, "inbox", "commitment")] }));
      },
    });
    await ui.until(() => ui!.$("#node-board"), "the team board step");
    const label = (id: string) => ui!.$(`#node-${id}`)!.getAttribute("aria-label");
    expect(label("inbox")).toBe("Pool: approved, not picked yet. 2 in the pool");
    expect(label("board")).toBe("Team board: a teammate picks");
    expect(label("ready")).toBe("Ready to build: agents take only these. 1 ready to build");
    expect(ui.$("#edge-i-b")!.getAttribute("aria-label")).toBe("Pool to Team board: 2 tasks in the pool now");
    expect(ui.$("#edge-i-r")!.getAttribute("aria-label")).toBe("Team board to Ready to build: 1 tasks ready now");

    await ui.click(ui.$("#node-board")!);
    await ui.until(() => ui!.text(".fdetail").includes("In the pool now"), "the board step's detail");
    const detail = ui.text(".fdetail");
    expect(detail).toMatch(/In the pool now\s*2/);
    expect(detail).toMatch(/Ready to build now\s*1/);
    expect(detail).toContain("Your team's board isn't published in Claude yet.");

    // Status's steps list it too.
    await ui.go("status/flow");
    await ui.until(() => ui!.text().includes("A teammate picks"), "Status's steps");
    const steps = ui.all("ol.steps > li").map((li) => li.querySelector("header b")!.textContent);
    expect(steps).toEqual(["Sources", "Privacy filter", "Claude reads", "You decide", "Linear", "Team board", "Agents draft", "Review"]);
    expect(ui.text("ol.steps")).toMatch(/Ready to build now\s*1/);
  });
});
