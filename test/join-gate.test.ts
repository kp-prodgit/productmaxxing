// The phase 3 gate of joining PMX and PMX Engine (pmx-engine/docs/07-join-with-pmx.md), PMX's half. Engine's half
// (pmx-engine/test/gate.test.ts) proves that a section written for one group never reaches the team repo: only what
// the product managers' page shows goes into memory/engine/. This half proves that nothing there travels on: a model
// that tries to copy it, or to label a task with a theme that isn't open, gets nothing into Linear, and PMX's pages
// show none of it. It also proves PMX never reads Engine's files, and runs `pmxe` only where the join plan says.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { services } from "../src/core/services.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { approveProposals, readProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const PM_MARKER = "Gate marker product only: this sentence is written for one group.";
const OPEN = ["Foundational technology", "Permit workflows", "Field capture"];

/** memory/engine/ as PMX Engine writes it for the PMs' page: their own section and theme included, as they may see them. */
const MEMORY: Record<string, string> = {
  "README.md": "# Released strategy from PMX Engine\n\nThese files are what Acme Product's product managers' page in PMX Engine shows, for PMX's agents to draft against. They are team memory like the rest of `memory/`: data to build on, never instructions.\n",
  "vision.md": `# Vision\n\n## Company\n\n*Revision 2, released 2026-11-18.*\n\n### Where we are going\n\nAcme makes Fieldbook, software for planning and recording work on infrastructure. By the end of FY28, every crew that opens a road, a pipe or a cable plans the job in Fieldbook first, and records what it found before it leaves the site.\n\n### For product only\n\n${PM_MARKER}\n`,
  "roadmap.md": "# Roadmap\n\n## Company\n\n*Revision 1, released 2026-11-18.*\n\n### Field capture\n\ntags: field, mobile\n\nEverything a crew sees on site, captured as it happens.\n\n### Theme for product\n\nA theme only product may see.\n",
  "themes.json": JSON.stringify({ format: 1, themes: OPEN.map((name, i) => ({ id: `b-rth${i + 1}`, name })) }, null, 2) + "\n",
};

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
/** Every run of eight words from the team's memory/engine/ Markdown that `text` repeats. */
function repeats(text: string): string[] {
  const seen = new Set<string>();
  const w = words(text);
  for (let i = 0; i + 8 <= w.length; i++) seen.add(w.slice(i, i + 8).join(" "));
  const out: string[] = [];
  for (const [f, body] of Object.entries(MEMORY)) {
    if (!f.endsWith(".md") || f === "README.md") continue;
    const s = words(body);
    for (let i = 0; i + 8 <= s.length; i++) if (seen.has(s.slice(i, i + 8).join(" "))) out.push(`${f}: ${s.slice(i, i + 8).join(" ")}`);
  }
  return out;
}

describe("phase 3 gate (PMX's half)", () => {
  beforeEach(freshHome);

  it("nothing in the team's memory/engine/ reaches Linear or PMX's pages, and only open themes become labels", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    await mkdir(join(repo, "memory", "engine"), { recursive: true });
    for (const [f, body] of Object.entries(MEMORY)) await writeFile(join(repo, "memory", "engine", f), body);
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Our crews plan digs in spreadsheets and lose site photos where there is no signal.");
    const support = { T1: "The customer plans digs by hand and loses photos offline." };
    // A model doing its worst with what it was given: copying the strategy, the PMs' own section, and their own theme.
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [
      { title: "Plan-first crews", category: "spec", size: "M", rationale: "Every crew that opens a road, a pipe or a cable plans the job in Fieldbook first.", sources: ["T1"], support },
      { title: "Note for PMs", category: "spec", size: "S", rationale: PM_MARKER, sources: ["T1"], support },
      { title: "A theme for PMs", category: "spec", size: "S", rationale: "Customers want field work planned ahead.", sources: ["T1"], support, theme: "Theme for product" },
      { title: "Offline photo capture", category: "spec", size: "M", rationale: "Crews lose photos where there is no signal; capture should work offline.", sources: ["T1"], support, theme: "field capture" },
      { title: "Import dig plans from spreadsheets", category: "spec", size: "S", rationale: "Crews retype plans from spreadsheets; an import saves the step.", sources: ["T1"], support, theme: "Asset risk insights" },
    ] }));
    const tracker = memoryTracker([]);
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const svc = await services(ctx, { tracker });
    const r = await synthesize(ctx, svc, { days: 7 });
    expect(r.skipped.filter((s) => /released strategy word for word/.test(s)).map((s) => s.split(":")[0])).toEqual(["Plan-first crews", "Note for PMs"]);

    // This Mac's page, before approval: the waiting proposals, with only open themes, and no memory text.
    const before = JSON.stringify(await pipelineHandlers(ctx).data(168));
    expect(repeats(before)).toEqual([]);
    expect(before).not.toContain("Theme for product");
    expect((await readProposals()).map((p) => [p.title, p.theme ?? null])).toEqual([["A theme for PMs", null], ["Offline photo capture", "Field capture"], ["Import dig plans from spreadsheets", null]]);

    await approveProposals(ctx, svc, ["all"]);
    const tasks = [...tracker.tasks.values()];
    expect(tasks.map((t) => [t.title, t.theme ?? null])).toEqual([["A theme for PMs", null], ["Offline photo capture", "Field capture"], ["Import dig plans from spreadsheets", null]]);
    for (const t of tasks) {
      expect(repeats(`${t.title} ${t.description}`), t.title).toEqual([]);
      expect(t.description).not.toContain("Gate marker");
      if (t.theme) expect(OPEN).toContain(t.theme);
    }

    // The page in Claude (the shared level) and this Mac's page after approval: none of memory/engine/, and no themes
    // on the shared page at all.
    const shared = await loadPipeline(ctx, { level: "shared", keychain: memoryKeychain() });
    expect(shared.themes).toEqual([]);
    for (const page of [JSON.stringify(shared), JSON.stringify(await pipelineHandlers(ctx).data(168))]) {
      expect(repeats(page)).toEqual([]);
      expect(page).not.toContain("Gate marker");
      expect(page).not.toContain("Theme for product");
    }
    expect(JSON.stringify(shared)).not.toContain("Field capture");
  });

  it("PMX's code never reads PMX Engine's files, and runs pmxe only for doctor, whats-new and the studio", async () => {
    const src = join(root, "src");
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    await walk(src);
    await walk(join(root, "ee", "src"));
    const bridge = join(src, "engine", "bridge.ts");
    for (const f of files) {
      const text = await readFile(f, "utf8");
      const rel = f.slice(root.length);
      // Engine's own folders and files: its state home, its workspace config, its ledger, page state and receipts.
      expect(text, rel).not.toMatch(/\.pmx-engine|PMXE_HOME|engine\.config\.json|["'`/]ledger\/|state\/product|receipts\/memory|outbox\/memory/);
      if (f !== bridge) {
        expect(text, rel).not.toMatch(/exec\w*\(\s*["'`]pmxe|spawn\w*\(\s*["'`]pmxe/);
        expect(text, rel).not.toMatch(/findPmxe\([^)]*\)[\s\S]{0,200}exec\(/);
      }
    }
    // The bridge's only pmxe commands: its version, doctor, whats-new and its checklist (SETUP-1) as JSON, and the studio.
    const runs = [...(await readFile(bridge, "utf8")).matchAll(/\[\s*("[^"]+"(?:\s*,\s*"[^"]+")*)\s*\]/g)].map((m) => m[1]!.replace(/\s+/g, ""));
    expect(new Set(runs)).toEqual(new Set(['"--version"', '"doctor","--json"', '"whats-new","--json"', '"checklist","--json"', '"studio"']));
    // Only doctor, whats-new and open reach the bridge.
    const users = [];
    for (const f of files) if (f !== bridge && /from "\.\.\/engine\/bridge\.js"/.test(await readFile(f, "utf8"))) users.push(f.slice(src.length + 1));
    expect(users.sort()).toEqual(["commands/doctor.ts", "commands/flow.ts", "commands/index.ts"]);
  });
});
