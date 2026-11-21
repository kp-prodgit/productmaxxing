// One look (phase 1 of joining PMX and PMX Engine, Q15): the team board uses the PMX Workspace's colour and type
// tokens byte for byte. PMX Engine's studio copies the same marked block and checks it on its side.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// design/build.mjs is plain JavaScript with no types; the test only calls build() and part().
import { build, part, DIST, lint } from "../design/build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const page = (rel: string) => readFile(join(root, rel), "utf8");

/** The lines between `/* >>> tokens *\/` and `/* <<< tokens *\/`. */
export function tokenBlock(text: string): string {
  const lines = text.split("\n");
  const a = lines.indexOf("/* >>> tokens */");
  const b = lines.indexOf("/* <<< tokens */");
  if (a < 0 || b < a) throw new Error("no token block");
  return lines.slice(a + 1, b).join("\n");
}

describe("one look: the team board shares the Workspace's tokens", () => {
  it("copies the marked block byte for byte, with light and both dark blocks", async () => {
    const workspace = tokenBlock(await page("app-skills/pmx-flow/pipeline.html"));
    const board = tokenBlock(await page("app-skills/pmx-board/board.html"));
    expect(board).toBe(workspace);
    expect(workspace).toMatch(/^:root \{/);
    expect(workspace).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {');
    expect(workspace).toContain(':root[data-theme="dark"] {');
  });

  it("draws the board's own names from the shared tokens, and loads no web font", async () => {
    const board = await page("app-skills/pmx-board/board.html");
    expect(board).not.toMatch(/fonts\.(googleapis|gstatic)/);
    expect(board).toContain("--surface: var(--card)");
    expect(board).toContain("--sans: var(--font)");
    // A board name is never given a colour of its own in light or dark, so it cannot drift from the Workspace.
    const own = board.slice(board.indexOf("/* <<< tokens */"), board.indexOf("* { box-sizing"));
    for (const name of ["--surface", "--muted", "--faint", "--accent", "--fg", "--bg", "--line"]) {
      expect(own).not.toMatch(new RegExp(`${name}:\\s*#`));
    }
  });

  it("marks Connect, which asks on the Mac, with the Mac sign PMX Engine's studio uses", async () => {
    const workspace = await page("app-skills/pmx-flow/pipeline.html");
    // The same glyph as pmx-engine's studio/studio.html, so the sign reads the same in both.
    expect(workspace).toContain('<symbol id="i-mac" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></symbol>');
    expect(workspace).toMatch(/"Connect", \{ cls: "pri", icon: "mac", title: "PMX asks you in a dialog on your Mac"/);
  });
});

describe("one source: design/ builds the parts every page copies", () => {
  const built = build() as { css: string; tokens: string; scale: string; components: string };

  it("ships a design/dist/pmx.css that matches a fresh build of tokens.json and parts/", async () => {
    expect(await readFile(DIST, "utf8")).toBe(built.css);
    expect(part(built.css, "tokens")).toBe(built.tokens);
    expect(part(built.css, "scale")).toBe(built.scale);
    expect(part(built.css, "components")).toBe(built.components);
  });

  it("copies the built tokens part into the Workspace and the board, with the darker dark veil", async () => {
    for (const rel of ["app-skills/pmx-flow/pipeline.html", "app-skills/pmx-board/board.html"]) {
      expect(tokenBlock(await page(rel))).toBe(built.tokens);
    }
    const darks = built.tokens.split("\n").filter((l: string) => l.includes("--scrim:"));
    expect(darks).toEqual([
      "  --scrim: rgba(10,12,18,.35); --knob: #ffffff; --toast-hover: rgba(127,127,127,.25);",
      "  --scrim: rgba(0,0,0,.6); --shadow-1: 0 1px 2px rgba(0,0,0,.4); --shadow: 0 10px 30px rgba(0,0,0,.45); color-scheme: dark } }",
      "  --scrim: rgba(0,0,0,.6); --shadow-1: 0 1px 2px rgba(0,0,0,.4); --shadow: 0 10px 30px rgba(0,0,0,.45); color-scheme: dark }",
    ]);
  });

  it("carries the scale part byte for byte in both pages, right after the tokens part", async () => {
    const workspace = await page("app-skills/pmx-flow/pipeline.html");
    const board = await page("app-skills/pmx-board/board.html");
    expect(part(board, "scale")).toBe(part(workspace, "scale"));
    expect(part(workspace, "scale")).toBe(built.scale);
    for (const text of [workspace, board]) expect(text).toContain("/* <<< tokens */\n/* >>> scale */\n");
  });

  it("never redefines --font or --mono outside the tokens part; the scale part aliases them", () => {
    expect(built.scale).toContain("--font-sans: var(--font); --font-mono: var(--mono);");
    for (const p of [built.scale, built.components]) expect(p).not.toMatch(/--(font|mono)\s*:/);
  });

  it("refuses style attributes, url(), @import and raw colours outside the tokens part", () => {
    const light = new Map([["bg", "#ffffff"]]);
    const bad = lint("x.css", '.a { color: #fff } .b { background: url(x.png) } @import "y.css"; .c { color: rgba(0,0,0,.1) } /* style="--x: 1" */', light);
    expect(bad.join("\n")).toMatch(/raw hex/);
    expect(bad.join("\n")).toMatch(/url\(/);
    expect(bad.join("\n")).toMatch(/@import/);
    expect(bad.join("\n")).toMatch(/colour function/);
    expect(bad.join("\n")).toMatch(/style attribute/);
    // The two documented exceptions: a marked literal-colours region, whose report-sheet values must be the light values.
    expect(lint("ok.css", "@media print { /* >>> literal colours: print */ :root { --bg: #fff !important } /* <<< literal colours */ }", light)).toEqual([]);
    expect(lint("rp.css", ".rp { /* >>> literal colours: report sheet */ --bg: #fffffe; /* <<< literal colours */ }", light).join()).toMatch(/restates --bg/);
  });
});
