import { afterEach, describe, expect, it, vi } from "vitest";
import { openBoard, type Ui } from "./ui-helpers.js";

// Nothing here may start a server or open a browser: the page's actions reach a stand-in for this Mac's page.
const page = vi.hoisted(() => ({ running: false, since: null as string | null, calls: [] as string[] }));
vi.mock("../src/flow/web-server.js", async (orig) => ({
  ...(await orig<typeof import("../src/flow/web-server.js")>()),
  webServerStatus: async () => ({ running: page.running, since: page.since }),
  openWebServer: async () => { page.calls.push("open"); const started = !page.running; page.running = true; page.since = "2026-11-20T10:00:00.000Z"; return { started }; },
  stopWebServer: async () => { page.calls.push("stop"); const was = page.running; page.running = false; page.since = null; return was; },
}));

describe("the page in Claude opens this Mac's page (BOARD-8)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; page.running = false; page.since = null; page.calls = []; });

  it("shows whether it runs, starts and opens it, and stops it", async () => {
    ui = await openBoard({ app: true, hash: "today" });
    const local = () => ui!.$("#local") as HTMLButtonElement;
    await ui.until(() => !local().hidden, "the page-on-this-Mac indicator");
    expect(ui.text("#local")).toBe("Page on this Mac · Not running");
    expect(local().className).toBe("conn off");

    await ui.click(local());
    await ui.until(() => ui!.text("#local-t") === "Running", "the page to show it running");
    expect(ui.posts.filter((p) => p[0] === "local-page")).toEqual([["local-page", { action: "open" }]]);
    expect(page.calls).toEqual(["open"]);
    expect(ui.text("#toast")).toContain("Started PMX's page on this Mac and opened it in your browser.");
    expect(local().className).toBe("conn");
    expect(local().getAttribute("aria-label")).toMatch(/^Open PMX's page on this Mac, outside Claude\. Running since /);

    await ui.go("settings/account");
    await ui.until(() => ui!.text().includes("Page on this Mac"), "the Account pane");
    expect(ui.text()).toMatch(/Running since/);
    await ui.click(ui.button("Stop", "main"));
    await ui.until(() => ui!.text("#local-t") === "Not running", "the page to show it stopped");
    expect(page.calls).toEqual(["open", "stop"]);
    expect(ui.button("Start and open", "main")).toBeTruthy();
  });

  it("isn't offered on this Mac's own page", async () => {
    ui = await openBoard({ hash: "settings/account" });
    await ui.until(() => ui!.text().includes("Connection"), "the Account pane");
    expect((ui.$("#local") as HTMLButtonElement).hidden).toBe(true);
    expect(ui.text()).not.toContain("Page on this Mac");
  });
});
