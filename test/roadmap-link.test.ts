// Bridge 1 of joining PMX and PMX Engine (EQ-28, CLI-7): every PM's Workspace links to the product managers' page.
// PMX holds only the link, from team config; the page itself lives in PMX Engine's hubs.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, loadTeamConfig } from "../src/core/config.js";
import { tmp } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const ROADMAP = "https://claude.ai/artifact/RoadmapForPMs1";

describe("the Roadmap link (CLI-7)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("shows on this Mac's page and on the page in Claude when the team has a roadmap page", async () => {
    for (const app of [false, true]) {
      ui = await openBoard({ team: { roadmap: { url: ROADMAP } }, app });
      const link = await ui.until(() => { const a = ui!.$("#act-roadmap"); return a && !a.hidden ? a : null; }, "the Roadmap link");
      expect(link.getAttribute("href")).toBe(ROADMAP);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      // The Strategy slot stays hidden: no PMX Engine on this Mac, so these servers know nothing about it.
      expect(ui.$("#nav-strategy")!.hidden).toBe(true);
      await ui.close();
      ui = null;
    }
  });

  it("stays hidden without one", async () => {
    ui = await openBoard({});
    await ui.until(() => ui!.$("#b-version")!.textContent, "the page to load");
    expect(ui.$("#act-roadmap")!.hidden).toBe(true);
    expect(ui.$("#act-roadmap")!.hasAttribute("href")).toBe(false);
  });

  it("accepts only a Claude artifact link in pmx.config.json", async () => {
    const repo = await tmp("roadmap-cfg-");
    await mkdir(repo, { recursive: true });
    const write = (roadmap: unknown) => writeFile(join(repo, "pmx.config.json"), JSON.stringify({ ...DEFAULT_TEAM, team: "t", roadmap }));
    await write({ url: "https://evil.example/roadmap" });
    await expect(loadTeamConfig(repo)).rejects.toThrow(/roadmap\.url must be a Claude artifact/);
    await write({ url: ROADMAP });
    expect((await loadTeamConfig(repo)).roadmap).toEqual({ url: ROADMAP });
  });
});
