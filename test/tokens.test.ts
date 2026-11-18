// One look (phase 1 of joining PMX and PMX Engine, Q15): the team board uses the PMX Workspace's colour and type
// tokens byte for byte. PMX Engine's studio copies the same marked block and checks it on its side.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
});
