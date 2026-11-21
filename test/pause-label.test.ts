import { afterEach, describe, expect, it } from "vitest";
import { registerServices } from "../src/core/services.js";
import { openBoard, type Ui } from "./ui-helpers.js";

// The reason ee/'s auto-pause gives when a kind of work's runs keep ending without a draft (RUN-4).
const WHY = "its last 3 runs, on 2 tasks, ended without a draft, so its skill may be broken; unpause with `pmx review --unpause spec`";
registerServices({ paused: async () => new Map([["spec", WHY]]) });

describe("a kind of work paused because its runs keep failing (RUN-4)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("says why on its card, without the command that resumes it", async () => {
    ui = await openBoard({ hash: "agents" });
    await ui.until(() => !!ui!.$("#cat-spec .banner"), "the spec card's banner");
    expect(ui.text("#cat-spec .banner")).toContain("Agents don't take these right now. Its last 3 runs, on 2 tasks, ended without a draft, so its skill may be broken.");
    expect(ui.text("#cat-spec")).not.toContain("pmx review");
  });

  it("labels it in Settings as failing, not as rejected", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    await ui.until(() => ui!.text().includes("Paused: runs keep failing"), "the spec row's pause label");
    expect(ui.text()).not.toContain("Paused: too many rejections");
  });
});
