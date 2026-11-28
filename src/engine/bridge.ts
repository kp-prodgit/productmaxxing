// The one place PMX talks to PMX Engine (Q16; phase 2 of pmx-engine/docs/07-join-with-pmx.md).
// It runs the `pmxe` command and reads only its versioned JSON: checks, release notes, the checklist and, for the
// Strategy area (BOARD-11), where Engine stands as labels; never content. It never reads Engine's files. The one command
// that changes anything is Engine's own updater, `pmxe update` with no other arguments, which `pmx update` runs (COMPAT-7).
// The background run only asks that updater whether a newer Engine is out (`pmxe update --check --json`, which installs
// nothing), so PMX can say so; it never installs Engine.
// Only commands import it (doctor, flow, index): they hand what it reads to the board by injection (src/flow/strategy.ts),
// and to `pmx install` the same way (src/setup/install.ts), never to anything Claude reads in a chat. Tests hold these
// rules (test/engine-bridge.test.ts, test/join-gate.test.ts).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandFile, onPath } from "../core/bin.js";
import type { Exec } from "../core/exec.js";
import type { EngineUpdate } from "../core/update.js";
import { compareVersions } from "../core/version.js";
import { engineViewOf, everyMinute, isStudioPlace, readEngineChecklist, type EngineChecklist, type EngineSource, type EngineView, type StudioPlace } from "../flow/strategy.js";

/** A PMX Engine version as `pmxe --version` prints it: a release, or a test build of one ("0.18.0-next.2", RELEASING.md). */
const ENGINE_VERSION = /^\d+\.\d+\.\d+(?:-next\.\d+)?$/;

/** The JSON format PMX understands from `pmxe doctor`, `whats-new`, `checklist` and `status`, each with `--json`. */
export const ENGINE_FORMAT = 1;

/** Where `npm install -g pmx-engine` usually puts the command, for a shell or job whose PATH lacks it. */
export const pmxeCandidates = (home = homedir()) => ["/opt/homebrew/bin/pmxe", "/usr/local/bin/pmxe", join(home, ".local/bin/pmxe"), join(home, ".npm-global/bin/pmxe")];

export interface Pmxe {
  cmd: string;
  /**
   * Arguments that come before PMX's own: Engine's JavaScript entry point, when PMX runs it with its own Node rather
   * than through its `#!/usr/bin/env node` line, which fails where `node` isn't on PATH (the background job's, say).
   */
  args?: string[];
  version: string;
  /** Where the command is installed, when PMX found it as a file. */
  path?: string;
}

/** PMX Engine is on this Mac but didn't answer (CLI-6): where it is installed, and why, in a few words. */
export interface PmxeProblem {
  path: string;
  reason: string;
}

const VERSION_MS = 20000;
/** PMX's arguments after the command's own leading ones. */
const argv = (p: Pick<Pmxe, "args">, args: string[]) => [...(p.args ?? []), ...args];

function why(r: { code: number; stdout: string; stderr: string }, ms: number): string {
  if (ms >= VERSION_MS - 500) return `it didn't answer within ${VERSION_MS / 1000} seconds`;
  const line = (r.code === 0 ? r.stdout : r.stderr || r.stdout).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (r.code === 0) return line ? `it answered "${line.slice(0, 60)}" instead of its version` : "it printed no version";
  return line ? line.replace(/^Error:\s*/, "").slice(0, 160) : `it stopped with exit code ${r.code}`;
}

/**
 * Finds PMX Engine's command, or says it's installed but didn't answer. Null when Engine isn't installed, as on every
 * PM's Mac: then nothing in PMX changes. Every `pmxe` on PATH and in the usual install folders is tried, through its
 * links: Engine's JavaScript runs with PMX's own Node, so a Node that only a login shell knows (nvm, say) doesn't
 * matter. PMX_PMXE pins the command (tests), and PMX_PMXE=none turns Engine off for PMX.
 */
export async function locatePmxe(exec: Exec, o: { candidates?: string[] } = {}): Promise<{ pmxe: Pmxe } | { problem: PmxeProblem } | null> {
  const pinned = process.env.PMX_PMXE;
  if (pinned === "none") return null;
  const names = pinned ? [pinned] : [...onPath("pmxe"), ...(o.candidates ?? pmxeCandidates())];
  const seen = new Set<string>();
  let problem: PmxeProblem | null = null;
  for (const name of names) {
    const f = name.includes("/") ? await commandFile(name) : null;
    if (name.includes("/") && !f) continue;
    if (seen.has(f?.real ?? name)) continue;
    seen.add(f?.real ?? name);
    // JavaScript with PMX's own Node first; then as the file says, in case that Node can't run it but PATH's can.
    for (const p of f?.js ? [{ cmd: process.execPath, args: [f.js] }, { cmd: name }] : [{ cmd: name }]) {
      const started = Date.now();
      const r = await exec(p.cmd, argv(p, ["--version"]), { timeoutMs: VERSION_MS });
      const v = r.code === 0 ? r.stdout.trim() : "";
      if (ENGINE_VERSION.test(v)) return { pmxe: { ...p, version: v, ...(f ? { path: name } : {}) } };
      problem ??= { path: name, reason: why(r, Date.now() - started) };
    }
  }
  // No file anywhere PMX looks: the system's own lookup, as before, for a command PMX's PATH reading missed.
  if (!pinned && !seen.size) {
    const started = Date.now();
    const r = await exec("pmxe", ["--version"], { timeoutMs: VERSION_MS });
    const v = r.code === 0 ? r.stdout.trim() : "";
    if (ENGINE_VERSION.test(v)) return { pmxe: { cmd: "pmxe", version: v } };
    if (!/ENOENT/.test(r.stderr)) problem = { path: "pmxe", reason: why(r, Date.now() - started) };
  }
  return problem ? { problem } : null;
}

/** PMX Engine's command, or null when it isn't installed or didn't answer. */
export async function findPmxe(exec: Exec, o: { candidates?: string[] } = {}): Promise<Pmxe | null> {
  const r = await locatePmxe(exec, o);
  return r && "pmxe" in r ? r.pmxe : null;
}

const tilde = (p: string) => p.replace(homedir(), "~");

/** The words for an Engine that's installed but didn't start, for `pmx doctor` and the checklist. */
export const problemText = (p: PmxeProblem) => `PMX Engine is installed at ${tilde(p.path)} but didn't start: ${p.reason}`;

/** A `pmxe … --json` answer, only at a format PMX knows. */
async function readJson(exec: Exec, p: Pmxe, args: string[]): Promise<Record<string, unknown> | null> {
  const r = await exec(p.cmd, argv(p, args), { timeoutMs: 30000 });
  try {
    const j = JSON.parse(r.stdout) as unknown;
    return j && typeof j === "object" && (j as Record<string, unknown>).format === ENGINE_FORMAT ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface EngineCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** Engine's problems never fail `pmx doctor`: PMX's own work doesn't wait on them. */
  level: "warn";
}

/** Engine's part of `pmx doctor`: one line, then each problem `pmxe doctor` found. Empty without Engine. */
export async function engineChecks(exec: Exec): Promise<EngineCheck[]> {
  const found = await locatePmxe(exec);
  if (!found) return [];
  if ("problem" in found) return [{ id: "engine", ok: false, level: "warn", detail: `${problemText(found.problem)}. In Terminal, pmxe --version shows why.` }];
  const p = found.pmxe;
  const j = await readJson(exec, p, ["doctor", "--json"]);
  if (!j) return [{ id: "engine", ok: false, level: "warn", detail: `PMX Engine ${p.version} is installed, but this pmx can't read its checks. Run pmxe doctor.` }];
  const checks = Array.isArray(j.checks) ? (j.checks as { level?: unknown; text?: unknown }[]) : [];
  const problems = checks.filter((c) => c.level === "warn" || c.level === "fail");
  const ws = typeof j.workspace === "string" ? j.workspace.replace(homedir(), "~") : null;
  return [
    { id: "engine", ok: true, level: "warn", detail: `PMX Engine ${p.version}${ws ? `, workspace folder ${ws}` : ""}: ${problems.length ? `${problems.length} to look at (pmxe doctor)` : "every check passes"}` },
    ...problems.map((c, i) => ({ id: `engine.${i + 1}`, ok: false, level: "warn" as const, detail: `PMX Engine: ${String(c.text ?? "")}` })),
  ];
}

export interface EngineNotes {
  version: string;
  since: string | null;
  notes: { version: string; title: string }[];
}

/**
 * Engine's release notes this Mac hasn't seen, for `pmx whats-new`. Reading them marks them seen in Engine too, so
 * the head of product is told once, wherever they look. Null without Engine or at a format PMX doesn't know.
 */
export async function engineNotes(exec: Exec): Promise<EngineNotes | null> {
  const p = await findPmxe(exec);
  if (!p) return null;
  const j = await readJson(exec, p, ["whats-new", "--json"]);
  if (!j) return null;
  const notes = Array.isArray(j.notes) ? (j.notes as { version?: unknown; title?: unknown }[]).map((n) => ({ version: String(n.version ?? ""), title: String(n.title ?? "") })) : [];
  return { version: p.version, since: typeof j.since === "string" ? j.since : null, notes };
}

/** How `pmx whats-new` shows Engine's notes. Empty when there are none. */
export function formatEngineNotes(e: EngineNotes | null): string {
  if (!e || !e.notes.length) return "";
  return [`PMX Engine ${e.version}`, ...e.notes.map((n) => `  ${n.version}${n.title ? `: ${n.title}` : ""}`), `  The details: pmxe whats-new${e.since ? ` --since ${e.since}` : ""}`].join("\n");
}

/**
 * Starts the studio, which opens in its own browser tab on this Mac; with a place (STU-40), straight at that place. A
 * studio already running is reused. A place that isn't one of the studio's own is refused: nothing runs.
 */
export function openStudio(p: Pmxe, place?: StudioPlace): boolean {
  if (place !== undefined && !isStudioPlace(place)) return false;
  const child = spawn(p.cmd, argv(p, place ? ["studio", "--at", place] : ["studio"]), { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return true;
}

/**
 * SETUP-1, SETUP-3: PMX Engine's own checklist, read only from `pmxe checklist --json` (format 1), never Engine's
 * files, as PMX shows it after its own: Engine's steps without their commands. Null without Engine; `checklist` is null
 * for an Engine too old to have one (then PMX says only its version).
 */
export async function engineChecklist(exec: Exec, o: { candidates?: string[] } = {}): Promise<{ version: string; checklist: EngineChecklist | null } | { problem: PmxeProblem } | null> {
  const found = await locatePmxe(exec, o);
  if (!found) return null;
  if ("problem" in found) return { problem: { ...found.problem, path: tilde(found.problem.path) } };
  const p = found.pmxe;
  return { version: p.version, checklist: readEngineChecklist(await readJson(exec, p, ["checklist", "--json"])) };
}

const UPDATE_MS = 600000;

/**
 * COMPAT-7: one update. `pmx update`, which a person runs (never the background job), runs PMX Engine's own updater next,
 * so Engine installs its new version where it was installed and runs its own upgrade steps, as its docs say. No other
 * arguments, so nothing overrides Engine's refusal while a release is being sent. Null where Engine isn't on this Mac.
 */
export async function runEngineUpdate(exec: Exec): Promise<EngineUpdate | null> {
  const p = await findPmxe(exec);
  if (!p) return null;
  const r = await exec(p.cmd, argv(p, ["update"]), { timeoutMs: UPDATE_MS });
  const out = `${r.stdout}\n${r.stderr}`;
  const updated = out.match(/Updated pmx-engine from (\d+\.\d+\.\d+(?:-next\.\d+)?) to (\d+\.\d+\.\d+(?:-next\.\d+)?)/);
  if (r.code === 0 && updated) return { result: "updated", from: updated[1]!, to: updated[2]! };
  if (r.code === 0) return { result: "current", version: out.match(/pmx-engine (\d+\.\d+\.\d+) is the latest/)?.[1] ?? p.version };
  if (/Not updating while a release is being sent/i.test(out)) return { result: "refused" };
  return { result: "failed", error: why(r, 0) };
}

/** How `pmxe update --check --json` answered: the newest PMX Engine, and whether this Mac's is behind it. */
export interface EngineLatest {
  current: string;
  latest: string;
  newer: boolean;
  /** Engine wouldn't update right now: a release is approved or being sent. */
  busy: boolean;
}

/** Before 0.5.2, `pmxe update --json` installed after reporting. PMX asks no older Engine. */
const ASKS_ONLY_SINCE = [0, 5, 2];
const parts = (v: string) => v.replace(/-.*$/, "").split(".").map(Number);
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };

/**
 * COMPAT-7: whether a newer PMX Engine is out, for the background run's first pass after a PMX update. It asks Engine's
 * own updater with `--check`, which only reports and installs nothing, in every Engine that has the command. PMX's
 * background run never installs Engine: `pmxe update` installs whatever npm calls the latest, checked only against
 * npm's own hash, with no review by the team, and the run installs nothing but the package the team's repo carries. So
 * PMX says a newer Engine is out and a person runs `pmxe update` (or `pmx update`, which runs it). Null where Engine
 * isn't on this Mac, is too old to ask, or didn't answer in a shape PMX knows.
 */
export async function engineLatest(exec: Exec): Promise<EngineLatest | null> {
  const p = await findPmxe(exec);
  if (!p || cmp(parts(p.version), ASKS_ONLY_SINCE) < 0) return null;
  const r = await exec(p.cmd, argv(p, ["update", "--check", "--json"]), { timeoutMs: 60000 });
  try {
    const j = JSON.parse(r.stdout) as { ok?: unknown; latest?: unknown; busy?: unknown };
    if (!j || j.ok !== true || typeof j.latest !== "string" || !/^\d+\.\d+\.\d+$/.test(j.latest)) return null;
    return { current: p.version, latest: j.latest, newer: (compareVersions(j.latest, p.version) ?? 0) > 0, busy: Array.isArray(j.busy) && j.busy.length > 0 };
  } catch {
    return null;
  }
}

/**
 * BOARD-11: where PMX Engine stands, for the Strategy area and Needs you, from `pmxe status --json` (format 1) and,
 * unless `checklist` is false, `pmxe checklist --json`. Labels only (src/flow/strategy.ts checks every field). Null
 * where Engine isn't on this Mac. An Engine too old for `status --json`, or one that answers with an error, is a view
 * that says so.
 */
export async function engineView(exec: Exec, o: { checklist?: boolean } = {}): Promise<EngineView | null> {
  const found = await locatePmxe(exec);
  if (!found) return null;
  const at = new Date().toISOString();
  if ("problem" in found) return { state: "problem", version: null, at, workspace: null, waiting: [], releases: [], pages: null, checklist: null, problem: problemText(found.problem) };
  const p = found.pmxe;
  const [status, checklist] = await Promise.all([
    readJson(exec, p, ["status", "--json"]),
    o.checklist === false ? null : readJson(exec, p, ["checklist", "--json"]),
  ]);
  return engineViewOf(p.version, at, status, readEngineChecklist(checklist));
}

/**
 * What a command hands the board (BOARD-11): Engine's view, read at most once a minute however often the page loads,
 * and the studio opened at a place, checked against the studio's own places before anything runs.
 */
export function engineSource(exec: Exec, o: { checklist?: boolean } = {}): EngineSource {
  const view = everyMinute(() => engineView(exec, o));
  return {
    view,
    async open(place) {
      if (!isStudioPlace(place)) return { status: 400, body: { error: "That isn't a place in PMX Engine's studio." } };
      const p = await findPmxe(exec);
      if (!p) return { status: 404, body: { error: "PMX Engine isn't on this Mac." } };
      openStudio(p, place);
      return { status: 200, body: { message: "Opening PMX Engine's studio in your browser on this Mac." } };
    },
  };
}
