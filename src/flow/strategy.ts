// BOARD-11 and SETUP-3 (usability slice 4): PMX Engine inside PMX's page, for the head of product, who uses both.
// Plain data here: what `pmxe status --json` and `pmxe checklist --json` may bring into PMX, checked field by field,
// and the shape PMX's page shows. Only src/engine/bridge.ts runs pmxe; it reads through these functions and hands the
// result to the board by injection (`EngineSource`), so nothing here reaches Engine itself.
//
// The never list (founder, 2026-11-21; pmx-engine docs/07): Engine's status shows live, as labels only, on the head of
// product's own paired page (`board`, `board_act`, which need the page's key) and on `pmx open`. Never in what Claude
// reads through `pmx mcp` (pipeline, checklist, flow_graph, the server's instructions), and never stored: not in ~/.pmx,
// not at claude.ai. Only labels cross: every field is checked and cut to size, and any field PMX doesn't know is dropped.

/** The studio's own addresses, the places `pmxe studio --at` opens (STU-40). A place is checked against these first. */
export const STUDIO_PLACES = ["home", "content", "roadmap", "product", "claude", "claude/earlier", "release", "release/ready", "release/earlier", "pages", "settings", "settings/team", "settings/verticals", "settings/groups", "settings/claude", "help"] as const;
export type StudioPlace = (typeof STUDIO_PLACES)[number];
export const isStudioPlace = (p: unknown): p is StudioPlace => typeof p === "string" && (STUDIO_PLACES as readonly string[]).includes(p);

export type EngineWho = "you" | "claude" | "a colleague";
export type EngineWhere = "studio" | "claude app" | "elsewhere";
const WHO: readonly string[] = ["you", "claude", "a colleague"];
const WHERE: readonly string[] = ["studio", "claude app", "elsewhere"];

/** One move in PMX Engine: whose it is, where it's made, and since when. `command`: the slash command, when one applies. */
export interface EngineWaiting {
  id: string;
  kind: string;
  label: string;
  who: EngineWho;
  where: EngineWhere;
  place: StudioPlace | null;
  since: string | null;
  command: string | null;
}

/** A release, hold or withdrawal in flight: the groups it reached, those still to come, and its next step. */
export interface EngineRelease {
  id: string;
  label: string;
  reached: string[];
  waiting: string[];
  next: { group: string; who: EngineWho; step: string } | null;
}

export type EngineStepStatus = "done" | "todo" | "warn" | "skip";

/**
 * One of Engine's checklist steps, as PMX shows it: no `do` text. `place`: an open step done in the studio, opened
 * there with "Open in the studio". `command`: the slash command for an open step done in the Claude app.
 */
export interface EngineStep {
  id: string;
  title: string;
  status: EngineStepStatus;
  detail: string;
  required: boolean;
  who: string | null;
  place: StudioPlace | null;
  command: string | null;
}

/** `pmxe checklist --json` (format 1) as PMX shows it after its own: Engine's words for the page, without commands. */
export interface EngineChecklist {
  format: 1;
  tool: "pmxe";
  version: string;
  at: string;
  where: string;
  next: { id: string; title: string } | null;
  sections: { id: string; title: string; steps: EngineStep[] }[];
  counts: Record<EngineStepStatus, number>;
}

/**
 * PMX Engine as PMX's page shows it (BOARD-11). `state`: "ok" when Engine said where it stands; "old" for an Engine
 * too old to (no `status --json`); "error" when it answered with an error; "problem" when it's installed but didn't
 * start (`problem` says where and why). Absent where Engine isn't on this Mac, as on every PM's.
 */
export interface EngineView {
  state: "ok" | "old" | "error" | "problem";
  version: string | null;
  /** When PMX read it. */
  at: string;
  workspace: string | null;
  waiting: EngineWaiting[];
  releases: EngineRelease[];
  pages: { count: number; ready: number } | null;
  checklist: EngineChecklist | null;
  problem?: string;
}

/** What the board is given to reach Engine (src/engine/bridge.ts makes it). Only commands may make one. */
export interface EngineSource {
  /** Engine as the page shows it, or null where it isn't on this Mac. Read at most once a minute. */
  view(): Promise<EngineView | null>;
  /** Opens the studio at one of its places in this Mac's browser. Anything but a place in STUDIO_PLACES is refused. */
  open(place: string): Promise<{ status: number; body: unknown }>;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A label: one line, at most `max` characters. */
const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t) : null;
};
const iso = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter((x): x is string => !!x).slice(0, 20) : []);
const ID = /^[\w.@:/-]{1,160}$/;

/**
 * Engine's words for PMX's page: a clause that names a pmx or pmxe command goes (the page names no commands, BOARD-5,
 * SETUP-2), and the tool is "PMX Engine" in the rest.
 */
export function engineWords(t: string): string {
  return t
    .replace(/\s*[(:;,—-]?\s*(?:[Rr]un|[Tt]ry|with|then|use|see|or|[Ii]n Terminal:?)?\s*`?\bpmxe? (?!(?:cannot|can|does|did|has|is|was|will|never|only|keeps)\b)[a-z][^`;.)]*`?\)?/g, "")
    .replace(/(?<![/\w-])pmxe(?![\w-])/g, "PMX Engine")
    .replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").replace(/([.!?])[.,;:]+/g, "$1").replace(/^[\s:;,.]+|[:;,]\s*$/g, "").trim();
}

/**
 * The slash command for a move made in the Claude app, when one applies: /pmxe-hubs sets pages up, and an approved
 * group is sent with /pmxe-release and its release and group (Engine's `send:<release>:<group>`). Else none: the
 * studio shows the step.
 */
function commandFor(kind: string, id: string, where: EngineWhere, who: EngineWho): string | null {
  if (where !== "claude app" || who !== "you") return null;
  if (kind === "pages") return "/pmxe-hubs";
  const m = kind === "send" ? /^send:([\w.@-]{1,80}):([\w-]{1,40})$/.exec(id) : null;
  return m ? `/pmxe-release ${m[1]} ${m[2]}` : null;
}

function waitingItem(v: unknown): EngineWaiting | null {
  const w = rec(v);
  if (!w) return null;
  const id = typeof w.id === "string" && ID.test(w.id) ? w.id : null;
  const kind = typeof w.kind === "string" && /^[a-z-]{1,24}$/.test(w.kind) ? w.kind : null;
  const label = str(w.label, 240);
  if (!id || !kind || !label || !WHO.includes(w.who as string) || !WHERE.includes(w.where as string)) return null;
  const who = w.who as EngineWho, where = w.where as EngineWhere;
  return { id, kind, label, who, where, place: isStudioPlace(w.place) ? w.place : null, since: iso(w.since), command: commandFor(kind, id, where, who) };
}

function releaseItem(v: unknown): EngineRelease | null {
  const r = rec(v);
  if (!r) return null;
  const id = typeof r.id === "string" && ID.test(r.id) ? r.id : null;
  const label = str(r.label, 160);
  if (!id || !label) return null;
  const n = rec(r.next);
  const next = n && str(n.group, 80) && WHO.includes(n.who as string) && str(n.step, 240) ? { group: str(n.group, 80)!, who: n.who as EngineWho, step: str(n.step, 240)! } : null;
  return { id, label, reached: names(r.reached), waiting: names(r.waiting), next };
}

/** Where an open step done in the studio is, by its section. */
const SECTION_PLACE: Record<string, StudioPlace> = { releases: "release", pages: "pages", claude: "home", pmx: "settings", workspace: "home", update: "home", mac: "home" };

/** `pmxe checklist --json` (format 1) as PMX shows it: Engine's steps, statuses and details, without any `do` text. */
export function readEngineChecklist(raw: unknown): EngineChecklist | null {
  const j = rec(raw);
  if (!j || j.format !== 1 || j.tool !== "pmxe" || !Array.isArray(j.sections)) return null;
  const counts: Record<EngineStepStatus, number> = { done: 0, todo: 0, warn: 0, skip: 0 };
  const sections = j.sections.slice(0, 12).flatMap((x) => {
    const s = rec(x);
    const id = s && typeof s.id === "string" && /^[a-z][\w-]{0,40}$/.test(s.id) ? s.id : null;
    const title = s && str(s.title, 80);
    if (!s || !id || !title || !Array.isArray(s.steps)) return [];
    const steps = s.steps.slice(0, 60).flatMap((y): EngineStep[] => {
      const t = rec(y);
      const sid = t && typeof t.id === "string" && /^[a-z][\w.-]{0,80}$/.test(t.id) ? t.id : null;
      const st = t && str(t.title, 160);
      const status = t && (["done", "todo", "warn", "skip"] as const).find((k) => k === t.status);
      if (!t || !sid || !st || !status) return [];
      const open = status === "todo" || status === "warn";
      const how = typeof t.how === "string" ? t.how : null;
      const slash = typeof t.do === "string" ? /^\/pmxe-[a-z-]{1,30}(?=[\s,.;]|$)/.exec(t.do)?.[0] ?? null : null;
      counts[status]++;
      return [{
        id: sid, title: engineWords(st) || st, status, detail: engineWords(str(t.detail, 400) ?? ""), required: t.required === true,
        who: typeof t.who === "string" && /^[a-z-]{1,16}$/.test(t.who) ? t.who : null,
        // A step done in the studio opens there, and so does a missing command (the studio's Home installs them); one
        // Claude does is its slash command; any other terminal step is Engine's own setup guide's, in its workspace
        // (/pmxe-setup). A step on the Mac or elsewhere says what's true only.
        place: open && (how === "studio" || (how === "terminal" && sid.startsWith("claude.skill."))) ? SECTION_PLACE[id] ?? "home" : null,
        command: open && how === "claude" ? slash ?? "/pmxe-setup" : open && how === "terminal" && !sid.startsWith("claude.skill.") ? "/pmxe-setup" : null,
      }];
    });
    return steps.length ? [{ id, title, steps }] : [];
  });
  const n = rec(j.next);
  const next = n && typeof n.id === "string" && /^[a-z][\w.-]{0,80}$/.test(n.id) && str(n.title, 160) ? { id: n.id, title: engineWords(str(n.title, 160)!) || str(n.title, 160)! } : null;
  return { format: 1, tool: "pmxe", version: str(j.version, 20) ?? "", at: iso(j.at) ?? new Date().toISOString(), where: engineWords(str(j.where, 400) ?? ""), next, sections, counts };
}

/**
 * The page's view from what Engine answered: `status` is `pmxe status --json` as parsed, or null when this Engine
 * gave no JSON at a format PMX knows (too old). An Engine that can't say where it stands still gives its checklist's
 * next step, as the one card Needs you shows for it.
 */
export function engineViewOf(version: string, at: string, status: Record<string, unknown> | null, checklist: EngineChecklist | null): EngineView {
  const base: EngineView = { state: "ok", version, at, workspace: null, waiting: [], releases: [], pages: null, checklist };
  const fallback = (): EngineWaiting[] => (checklist?.next ? [{ id: `setup:${checklist.next.id}`, kind: "setup", label: checklist.next.title, who: "you", where: "elsewhere", place: "home", since: null, command: "/pmxe-setup" }] : []);
  if (!status || status.tool !== "pmxe") return { ...base, state: "old", waiting: fallback() };
  if (typeof status.error === "string") return { ...base, state: "error", waiting: fallback() };
  const ws = rec(status.workspace);
  const pages = rec(status.pages);
  return {
    ...base,
    workspace: ws ? str(ws.name, 80) : null,
    waiting: Array.isArray(status.waiting) ? status.waiting.slice(0, 60).map(waitingItem).filter((x): x is EngineWaiting => !!x) : [],
    releases: Array.isArray(status.releases) ? status.releases.slice(0, 40).map(releaseItem).filter((x): x is EngineRelease => !!x) : [],
    pages: pages ? { count: num(pages.count), ready: Math.min(num(pages.ready), num(pages.count)) } : null,
  };
}

/** Engine's moves that are the head of product's own: Needs you's "PMX Engine" cards, and what `needsYou` counts. */
export const engineMine = (e: EngineView | null | undefined): EngineWaiting[] => (e ? e.waiting.filter((w) => w.who === "you") : []);

/** A read that runs at most once every `ms`: later calls get the last answer. Two calls at once share one read. */
export function everyMinute<T>(read: () => Promise<T>, ms = 60000, now = () => Date.now()): () => Promise<T> {
  let last: { at: number; value: T } | null = null;
  let pending: Promise<T> | null = null;
  return async () => {
    if (last && now() - last.at < ms) return last.value;
    pending ??= read().then((value) => { last = { at: now(), value }; return value; }).finally(() => { pending = null; });
    return pending;
  };
}

const MARK: Record<EngineStepStatus, string> = { done: "✔", todo: "✘", warn: "!", skip: "–" };

/** Engine's checklist for `pmx checklist`, after PMX's own: its sections, steps, statuses and details. */
export function formatEngineChecklist(c: EngineChecklist, o: { all?: boolean } = {}): string {
  const lines = [`PMX Engine ${c.version} on this Mac · checked ${new Date(c.at).toLocaleString()}`, "", `Where it stands: ${c.where}`];
  for (const sec of c.sections) {
    const shown = o.all ? sec.steps : sec.steps.filter((s) => s.status !== "skip");
    if (!shown.length) continue;
    lines.push("", sec.title);
    for (const s of shown) {
      lines.push(`  ${MARK[s.status]} ${s.title}${s.detail ? `: ${s.detail}` : ""}`);
      if (s.place) lines.push("      → Open in the studio (pmx open studio)");
      else if (s.command) lines.push(`      → In the Claude app, type ${s.command}${s.command === "/pmxe-setup" ? " in PMX Engine's workspace" : ""}`);
    }
  }
  lines.push("", c.next ? `Next in PMX Engine: ${c.next.title}. Each step's exact command: pmxe checklist` : "Nothing left to do in PMX Engine.");
  return lines.join("\n");
}
