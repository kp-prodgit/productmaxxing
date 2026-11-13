import { beforeEach, describe, expect, it } from "vitest";
import { installedVersion, pageProblem, pagesNote, stalePages } from "../src/claude/pages.js";
import { collectPrompt } from "../src/collect/collect.js";
import { handleMcp, serverInstructions } from "../src/mcp/server.js";
import { currentVersion } from "../src/core/version.js";
import { announceOnce, markUpdatingFrom } from "../src/core/whats-new.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const FLOW = "https://claude.ai/artifact/flow1";
const BOARD = "https://claude.ai/artifact/board1";
const at = "2026-11-10T09:00:00Z";
const call = (method: string, params: object, ctx: any) => handleMcp({ jsonrpc: "2.0", id: 1, method, params }, async () => ctx) as Promise<any>;

describe("0.24.1: after an update, Claude is told to publish the PMX pages again (FLOW-5, BOARD-1)", () => {
  beforeEach(freshHome);

  it("finds the pages this Mac published with another pmx, and not a board someone else shared", () => {
    expect(installedVersion()).toBe(currentVersion());
    const personal = { flow: { url: FLOW, version: "0.23.0", publishedAt: at }, board: { url: BOARD, version: "0.23.0", publishedAt: at } };
    expect(stalePages(null, personal, "0.24.1").map((p) => [p.skill, p.publishedVersion, p.version])).toEqual([["pmx-flow", "0.23.0", "0.24.1"], ["pmx-board", "0.23.0", "0.24.1"]]);
    expect(stalePages({ board: { url: BOARD } }, personal, "0.24.1")).toHaveLength(2); // the team shares the one this Mac published
    expect(stalePages({ board: { url: "https://claude.ai/artifact/theirs" } }, personal, "0.24.1").map((p) => p.skill)).toEqual(["pmx-flow"]);
    expect(stalePages(null, personal, "0.23.0")).toEqual([]);
    expect(stalePages(null, { flow: null, board: null }, "0.24.1")).toEqual([]);
  });

  it("the update's output tells the PM what to type and tells Claude to publish the pages itself", () => {
    expect(pagesNote([])).toBeNull();
    const [flow] = stalePages(null, { flow: { url: FLOW, version: "0.23.0", publishedAt: at }, board: null }, "0.24.1");
    const note = pagesNote([flow!])!;
    expect(note).toContain(`PMX workspace (${FLOW}), published with pmx 0.23.0`);
    expect(note).toContain("Type /pmx-flow in the Claude app. It keeps its link.");
    expect(note).toMatch(/Claude: if you ran this update or were asked to, use the pmx-flow skill now to publish it again with the same link/);
    expect(pageProblem(flow!)).toBe("Your PMX workspace in Claude was published with pmx 0.23.0, and this Mac now runs pmx 0.24.1. Type /pmx-flow in the Claude app to update it; it keeps its link.");
  });

  it("the first command after an npm update says it along with what's new", async () => {
    await markUpdatingFrom("0.23.0");
    const out: string[] = [];
    await announceOnce((s) => out.push(s), { pages: async () => "Update your PMX page in Claude: …" });
    expect(out.join("")).toMatch(/What's new in pmx[\s\S]*Update your PMX page in Claude/);
    // Nothing new to announce: no note either.
    await announceOnce((s) => out.push(s), { pages: async () => "again" });
    expect(out).toHaveLength(1);
  });

  it("pmx mcp tells Claude in the Claude app, and the page and the pipeline tool show it as a problem", async () => {
    const { repo } = await pmxRepo();
    const stale = await testCtx({ repo, personal: { flow: { url: FLOW, version: "0.23.0", publishedAt: at } } });
    const ins = await serverInstructions(async () => stale);
    expect(ins).toMatch(/never ask the user for a key/);
    expect(ins).toMatch(new RegExp(`PMX workspace was published with pmx 0\\.23\\.0 and pmx ${currentVersion().replace(/\./g, "\\.")} is installed: tell the user once, briefly, and offer to update it with the pmx-flow skill`));
    expect((await call("initialize", {}, stale)).result.instructions).toBe(ins);
    const health = (await call("tools/call", { name: "pipeline", arguments: {} }, stale)).result.structuredContent.health;
    expect(health.items).toContainEqual({ text: expect.stringMatching(/^Your PMX workspace in Claude was published with pmx 0\.23\.0/), cmd: "/pmx-flow" });
    expect(JSON.stringify(health)).not.toContain(FLOW); // the shared level never names the link

    const current = await testCtx({ repo, personal: { flow: { url: FLOW, version: currentVersion(), publishedAt: at } } });
    expect(await serverInstructions(async () => current)).not.toMatch(/Right now/);
    expect(JSON.stringify((await call("tools/call", { name: "pipeline", arguments: {} }, current)).result.structuredContent.health)).not.toMatch(/PMX workspace in Claude/);
  });

  it("the scheduled collection ends its report with it, and doesn't publish in that run", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, personal: { flow: { url: FLOW, version: "0.23.0", publishedAt: at } } });
    const p = await collectPrompt(ctx, { scope: "mine" });
    expect(p).toMatch(/End your report with this, word for word, so the user sees it: "Your PMX workspace in Claude was published with pmx 0\.23\.0[^"]*Type \/pmx-flow in the Claude app[^"]*" Don't publish or change the page yourself in this run\./);
    const fresh = await testCtx({ repo, personal: { flow: null } });
    expect(await collectPrompt(fresh, { scope: "mine" })).not.toMatch(/End your report/);
  });
});
