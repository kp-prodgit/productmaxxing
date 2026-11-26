import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import { startsNow } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt, writeReceipt, type SourceReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import type { Size } from "../core/types.js";
import { openThemes, themeNamed } from "./themes.js";
import { shareEvidence, stageShares } from "../run/share.js";
import { sentencesIn } from "../core/tracker-text.js";
import { groupsLine, mergeGroups, type SourceGroup } from "./synthesize.js";

/**
 * Proposed tasks waiting for the PM (APPROVE-1). Synthesis stages what it would write to the tracker here, exactly
 * as it would be written, and nothing reaches the tracker until the PM approves it. The file stays on this Mac:
 * `from` names the meetings by their own titles, for the PM's eyes only, and is never written anywhere else.
 */
export interface Proposal {
  id: string;
  at: string;
  receipt: string;
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
  from: { id: string; title: string; at: string; why: string }[];
  /**
   * Later runs that heard the same need again (INPUT-2): their receipts and how many sources each added. Their
   * meetings are in `from` too, marked with the receipt they came from.
   */
  again?: {
    receipt: string; at: string; n: number;
    /** N2: the IDs the added sources have in this proposal's own run, and the sentences its description gained. */
    ids?: string[]; added?: string[];
  }[];
  /** N2: the sources line's parts, so a later run's sources join it. Proposals staged before 0.37.0 have none. */
  sourceGroups?: SourceGroup[];
  /**
   * A roadmap theme from the team's memory/engine/themes.json (EQ-38), suggested by synthesis or set by the PM. It
   * becomes a pmx-theme label only if the theme is still open when the PM approves.
   */
  theme?: string;
  /**
   * FOLLOW-1: a follow-up from an accepted draft, not from synthesis: the task whose draft left the question, where that
   * draft is in the team repo, and whether the draft called it blocking or open. Shown as "Follows PMX-12". `draft`: the
   * draft's pull request, when it has one on the web. `more`: how many of the draft's questions stayed in it, over the cap.
   */
  follows?: { identifier: string; path: string; url?: string | null; where: "blocking" | "open"; draft?: string | null; more?: number };
}

interface Staged {
  v: 1;
  proposals: Proposal[];
}

export const proposalsFile = () => join(paths.staging(), "proposals.json");

export async function readProposals(): Promise<Proposal[]> {
  return (await readJson<Staged>(proposalsFile()))?.proposals ?? [];
}

async function save(proposals: Proposal[]): Promise<void> {
  await privateDir(paths.staging());
  await writeJson(proposalsFile(), { v: 1, proposals } satisfies Staged, 0o600);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Adds proposals, skipping any whose title is already waiting. Returns the ones added, with their IDs. */
export async function stageProposals(list: Omit<Proposal, "id">[]): Promise<Proposal[]> {
  return withLock(proposalsFile(), () => stageLocked(list));
}

async function stageLocked(list: Omit<Proposal, "id">[]): Promise<Proposal[]> {
  const all = await readProposals();
  const waiting = new Set(all.map((p) => norm(p.title)));
  const added: Proposal[] = [];
  for (const p of list) {
    if (hasCanary(JSON.stringify(p))) throw new Error(CANARY_REFUSAL);
    if (waiting.has(norm(p.title))) continue;
    const full = { ...p, id: `p${randomBytes(3).toString("hex")}` };
    added.push(full);
    waiting.add(norm(p.title));
  }
  await save([...all, ...added]);
  return added;
}

/** What a later run brings to a proposal still waiting (INPUT-2, N2). */
export interface MoreEvidence {
  /** The later run's receipt. */
  receipt: string;
  /** Its sources, by that run's IDs, for the PM's own view. */
  from: Proposal["from"];
  days: string[];
  /** N2: the later run's summary of the need, already through the tracker guard. Its new facts join the description. */
  rationale?: string;
  /** N2: those sources as the later run's receipt has them, so this proposal's own run learns them under new IDs. */
  sources?: SourceReceipt[];
  /** N2: each source's part of the sources line, by the later run's ID. */
  groups?: Record<string, SourceGroup>;
  /** N2: the Slack permalink a `pmx:source` line carries, by the later run's ID. */
  refs?: Record<string, string>;
  /** When the later run happened (ISO); now when not given. */
  at?: string;
}

/**
 * Adds a later run's sources to a proposal still waiting (INPUT-2). The PM sees every source under the proposal. N2:
 * what Linear would get changes with them: the description gains the later run's new facts (sentences it doesn't
 * already say, through the tracker guard), its Sources line counts the new sources, and each gets a `pmx:source` line,
 * under an ID the proposal's own synthesis run now records too, so `pmx explain` and the drafting agent find it. A
 * proposal from before N2, or whose run is gone, says how many more sources and when instead. False when the proposal
 * is gone (approved or dropped since).
 */
export async function addEvidence(id: string, e: MoreEvidence): Promise<boolean> {
  return withLock(proposalsFile(), () => evidenceLocked(id, e));
}

/** At most this many sentences join a description from one later run, and the summary stays under this many characters. */
const ADD_MAX = 3;
const SUMMARY_MAX = 1500;
const STOP = new Set("about after again also because been before being both could does from have into just more most much must only other over same should some such than that their them then there these they this those through very want were what when where which while will with would your the and for are was".split(" "));
const factWords = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}$][\p{L}\p{N}$'’.%-]*/gu) ?? []).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => /\d/.test(w) || (w.length >= 4 && !STOP.has(w))));

/** A sentence's content words, figures aside, with a plural's s dropped: what it's about rather than what it adds. */
const contentWords = (s: string) => new Set([...factWords(s)].filter((w) => !/\d|\$/.test(w)).map((w) => (w.length > 4 ? w.replace(/s$/, "") : w)));

/**
 * The same sentence said again in other words, like two "The brief should frame…": most content words of the larger
 * of the two (60%) are in both. A new figure or date doesn't make it new.
 */
export function nearDuplicate(a: string, b: string): boolean {
  const x = contentWords(a), y = contentWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(x.size, y.size) >= 0.6;
}

/**
 * The later run's sentences that say something the description doesn't: fewer than 60% of their words are in it, and
 * not a near-duplicate of one of its sentences (or of one added before it).
 */
export function newFacts(description: string, rationale: string, max = SUMMARY_MAX): string[] {
  const summary = description.split(/\n\n/)[0] ?? "";
  const have = factWords(summary);
  const said = sentencesIn(summary.replace(/\s+/g, " ").trim());
  const out: string[] = [];
  let len = summary.length;
  for (const s of sentencesIn(rationale.replace(/\s+/g, " ").trim())) {
    if (out.length >= ADD_MAX) break;
    const w = [...factWords(s)];
    if (!w.length || w.filter((x) => have.has(x)).length / w.length >= 0.6) continue;
    if (said.some((x) => nearDuplicate(x, s))) continue;
    if (len + s.length + 1 > max) continue;
    out.push(s);
    said.push(s);
    len += s.length + 1;
    for (const x of w) have.add(x);
  }
  return out;
}

const SOURCES_LINE_PARTS = /^\*\*Sources:\*\* (.*?)\. They stay on the PM's Mac(.*)$/m;

async function evidenceLocked(id: string, e: MoreEvidence): Promise<boolean> {
  const all = await readProposals();
  const p = all.find((x) => x.id === id);
  if (!p) return false;
  const seen = new Set(p.from.map((f) => `${f.title}|${f.at}`));
  const fresh = e.from.filter((f) => !seen.has(`${f.title}|${f.at}`));
  if (!fresh.length) return true;

  // N2: the proposal's own run learns the new sources, with IDs after its own, so its `pmx:source` lines, `pmx explain`
  // and the drafting agent's evidence (RUN-3, RUN-5) all find them. Only for a synthesis proposal with a Sources line.
  const ids = new Map<string, string>();
  const line = p.description.match(SOURCES_LINE_PARTS);
  const parts = fresh.map((f) => e.groups?.[f.id]).filter((g): g is SourceGroup => !!g);
  const full = !!line && parts.length > 0 && !p.follows;
  const r = full && e.sources?.length && p.receipt ? await readReceipt(p.receipt) : null;
  if (r) {
    const top: Record<string, number> = {};
    for (const x of r.sources) { const m = x.id?.match(/^([A-Z])(\d+)$/); if (m) top[m[1]!] = Math.max(top[m[1]!] ?? 0, Number(m[2])); }
    let changed = false;
    for (const f of fresh) {
      const src = e.sources!.find((x) => x.id === f.id && x.decision === "used");
      if (!src) continue;
      const known = r.sources.find((x) => x.decision === "used" && x.id && x.refHash === src.refHash);
      if (known) { ids.set(f.id, known.id!); continue; }
      const prefix = f.id.match(/^[A-Z]/)?.[0] ?? "T";
      const next = `${prefix}${(top[prefix] = (top[prefix] ?? 0) + 1)}`;
      r.sources.push({ ...src, id: next, addedFrom: e.receipt });
      ids.set(f.id, next);
      changed = true;
    }
    if (changed) await writeReceipt(r, e.at ? new Date(e.at) : new Date());
  }
  p.from = [...p.from, ...fresh.map((f) => ({ ...f, id: ids.get(f.id) ?? `${f.id}@${e.receipt}` }))];
  const newIds = [...new Set(fresh.map((f) => ids.get(f.id)).filter((x): x is string => !!x && !p.sources.includes(x)))];
  p.sources = [...p.sources, ...newIds];

  const added = full && e.rationale ? newFacts(p.description, e.rationale) : [];
  if (full && line) {
    // N2: Linear gets the later call's facts and its source, not only that it was heard again.
    const merged = p.sourceGroups ? mergeGroups(p.sourceGroups, parts) : null;
    const said = merged ? groupsLine(merged) : `${line[1]}; ${groupsLine(mergeGroups([], parts))}`;
    if (merged) p.sourceGroups = merged;
    const [summary, ...rest] = p.description.split("\n\n");
    let d = [added.length ? `${summary} ${added.join(" ")}` : summary, ...rest].join("\n\n");
    d = d.replace(SOURCES_LINE_PARTS, (_m, _old: string, tail: string) => `**Sources:** ${said}. They stay on the PM's Mac${tail}`);
    const lines = newIds.map((x) => {
      const from = [...ids].find(([, v]) => v === x)?.[0];
      return `pmx:source ${x}${from && e.refs?.[from] ? ` ${e.refs[from]}` : ""}`;
    });
    p.description = lines.length ? `${d.replace(/\s+$/, "")}${/(^|\n)pmx:source /.test(d) ? "\n" : "\n\n"}${lines.join("\n")}` : d;
  } else {
    // Before N2 (no Sources line, or no parts given), the description says how many more sources and when, never which.
    const more = (p.again ?? []).reduce((a, x) => a + x.n, 0) + fresh.length;
    const days = [...new Set([...(p.description.match(/^\*\*Heard again\*\*.*\(([^)]*)\)\.$/m)?.[1]?.split(", ") ?? []), ...e.days])].sort().join(", ");
    const heard = `**Heard again** in ${more === 1 ? "one more source" : `${more} more sources`} (${days}).`;
    p.description = /^\*\*Heard again\*\*.*$/m.test(p.description)
      ? p.description.replace(/^\*\*Heard again\*\*.*$/m, heard)
      : p.description.replace(/^(\*\*(?:Sources:|Based on)\*\*.*)$/m, `$1\n${heard}`);
  }
  p.again = [...(p.again ?? []), { receipt: e.receipt, at: e.at ?? new Date().toISOString(), n: fresh.length, ...(newIds.length ? { ids: newIds } : {}), ...(added.length ? { added } : {}) }];
  if (hasCanary(JSON.stringify(p))) throw new Error(CANARY_REFUSAL);
  await save(all);
  return true;
}

/** N2: what later runs changed in a proposal, for the PM: "Nov 26: 1 more source (T7), and 2 sentences in the description". */
export function changedText(p: Pick<Proposal, "again">): string | null {
  const ch = (p.again ?? []).filter((a) => a.ids?.length || a.added?.length);
  if (!ch.length) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return ch.map((a) => {
    const what = [a.ids?.length ? `${a.ids.length === 1 ? "1 more source" : `${a.ids.length} more sources`} (${a.ids.join(", ")})` : "", a.added?.length ? `${a.added.length === 1 ? "1 sentence" : `${a.added.length} sentences`} in the description: ${a.added.join(" ")}` : ""].filter(Boolean).join(", and ");
    return `${day(a.at)}, a later run added ${what}`;
  }).join(" · ");
}

/** Proposals matching what the PM typed: an ID, a 1-based number from `pmx proposals`, or "all". */
function pick(all: Proposal[], refs: string[]): { hit: Proposal[]; missing: string[] } {
  if (refs.includes("all") || refs.includes("--all")) return { hit: all, missing: [] };
  const hit: Proposal[] = [];
  const missing: string[] = [];
  for (const r of refs) {
    const p = /^\d+$/.test(r) ? all[Number(r) - 1] : all.find((x) => x.id === r.toLowerCase());
    if (p) { if (!hit.includes(p)) hit.push(p); }
    else missing.push(r);
  }
  return { hit, missing };
}

/** Marks each task in its synthesis receipt, so `pmx explain` and the flow view say what became of it (FLOW-1). */
async function markReceipt(p: Proposal, posted: { identifier: string } | { dropped: true } | { duplicateOf: string } | { todo: string }, now: Date): Promise<void> {
  const r = await readReceipt(p.receipt);
  const t = r?.synth?.tasks.find((x) => x.posted && "staged" in x.posted && x.posted.staged === p.id);
  if (!r || !t) return;
  t.posted = posted;
  await writeReceipt(r, now);
}

/**
 * The PM sets, changes or clears a proposal's roadmap theme (EQ-38). Only a theme open in the team's repo now is
 * accepted, spelled as the theme spells it. `null` clears it.
 */
export async function setProposalTheme(repo: string, refs: string[], name: string | null): Promise<{ changed: Proposal[]; missing: string[]; theme: string | null }> {
  const theme = name === null ? null : themeNamed(name, await openThemes(repo));
  if (name !== null && !theme) {
    const open = (await openThemes(repo)).map((t) => t.name);
    throw new Error(open.length ? `"${name}" isn't one of your team's open roadmap themes: ${open.join(", ")}.` : "Your team's repo has no open roadmap themes (memory/engine/themes.json, from PMX Engine's /pmxe-memory).");
  }
  return withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit, missing } = pick(all, refs);
    for (const p of hit) {
      if (theme) p.theme = theme;
      else delete p.theme;
    }
    await save(all);
    return { changed: hit, missing, theme };
  });
}

/** Start now is off for this team (APPROVE-3): a teammate decides what agents take. */
export const START_OFF = "Your team has a teammate decide what agents take, so Start now is off: approve the task and it waits in the backlog until a teammate moves it to Todo in Linear.";

/**
 * Writes the chosen proposals to the tracker, exactly as staged, and takes them off the list. By default each goes to
 * the pool (inbox). `start` is the PM's Start now (APPROVE-3): the same text, created straight in Ready, and only when
 * the team allows it. This is the only way a Ready task is created; synthesis itself only ever stages proposals.
 */
export async function approveProposals(ctx: Ctx, svc: Services, refs: string[], o: { start?: boolean } = {}): Promise<{ posted: { id: string; identifier: string; title: string; theme?: string; ready: boolean }[]; duplicates: string[]; missing: string[]; unthemed: string[]; notShared: string[] }> {
  if (o.start && !startsNow(ctx.team)) throw new Error(START_OFF);
  const all = await readProposals();
  const { hit, missing } = pick(all, refs);
  // EQ-38: a theme is checked again now, so one held, withdrawn or narrowed since it was suggested never becomes a label.
  const themes = hit.some((p) => p.theme) ? await openThemes(ctx.personal.repoPath) : [];
  const unthemed: string[] = [];
  // Only the same title stops a proposal the PM approved: synthesis already folded repeats in (INPUT-2), and the PM's
  // own decision isn't second-guessed by a fuzzy match.
  const open = new Map((await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => [norm(t.title), t.identifier]));
  const posted: { id: string; identifier: string; title: string; theme?: string; ready: boolean }[] = [];
  const duplicates: string[] = [];
  const done = new Set<string>();
  for (const p of hit) {
    const dup = open.get(norm(p.title));
    if (dup) {
      duplicates.push(`${p.title} (already ${dup})`);
      await markReceipt(p, { duplicateOf: dup }, ctx.now());
    } else {
      const theme = p.theme ? themeNamed(p.theme, themes) : null;
      if (p.theme && !theme) unthemed.push(`${p.title}: "${p.theme}" is no longer an open roadmap theme, so it went without one`);
      const t = await svc.tracker.createInbox({ title: p.title, description: p.description, category: p.category, size: p.size, sources: p.sources, ...(theme ? { theme } : {}), ...(o.start ? { ready: true } : {}) });
      posted.push({ id: p.id, identifier: t.identifier, title: t.title, ...(theme ? { theme } : {}), ready: !!o.start });
      open.set(norm(p.title), t.identifier);
      await markReceipt(p, { identifier: t.identifier }, ctx.now());
      // RUN-5: the quotes this task cites go to the team repo once it has its identifier, so any PM's agent can draft it.
      await stageShares(ctx, [{ identifier: t.identifier, title: p.title, description: p.description, sources: p.sources, follows: p.follows?.identifier ?? null }]);
    }
    done.add(p.id);
    // Saved after each one, so a failure halfway never posts the same task twice.
    await withLock(proposalsFile(), async () => save((await readProposals()).filter((x) => !done.has(x.id))));
  }
  // The approval stands whatever happens here: a pack that can't be written yet is tried again, and the PM told once.
  const shared = posted.length && ctx.team.tracker.kind !== "none" ? await shareEvidence(ctx, { say: "answer" }).catch((e: any) => ({ shared: [], notices: [`PMX couldn't share the quotes of ${posted.map((x) => x.identifier).join(", ")} with your team: ${e?.message ?? e}.`] })) : null;
  return { posted, duplicates, missing, unthemed, notShared: shared?.notices ?? [] };
}

/**
 * What approving did, in a PM's words (APPROVE-1, APPROVE-3): where the tasks went and when an agent takes them. Through
 * the Claude relay a task reaches Linear only at the next sync, and the words say so.
 */
export function approvedText(posted: { identifier: string }[], o: { start: boolean; startNow: boolean }): string {
  if (!posted.length) return "";
  const ids = posted.map((p) => p.identifier).join(", ");
  const one = posted.length === 1;
  const sync = posted.some((p) => p.identifier.startsWith("PENDING-"));
  if (o.start) return `Started ${ids}: ${one ? "it becomes" : "they become"} Ready for agents ${sync ? "in Linear at the next Claude sync" : "now"}, and ${one ? "an agent takes it" : "agents take them"} from there.`;
  if (o.startNow) return `Approved ${ids} for later: ${one ? "it waits" : "they wait"} in your team's backlog in Linear${sync ? " from the next Claude sync" : ""}. When you want an agent on ${one ? "it" : "one"}, move it to Todo in Linear.`;
  return `Approved ${ids}: ${one ? "it goes" : "they go"} to your team's backlog in Linear${sync ? " at the next Claude sync" : ""}. An agent takes ${one ? "it" : "one"} only after a teammate moves it to Todo in Linear.`;
}

export async function dropProposals(refs: string[], now = new Date()): Promise<{ dropped: Proposal[]; missing: string[] }> {
  const r = await withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit, missing } = pick(all, refs);
    const gone = new Set(hit.map((p) => p.id));
    await save(all.filter((p) => !gone.has(p.id)));
    return { dropped: hit, missing };
  });
  for (const p of r.dropped) await markReceipt(p, { dropped: true }, now);
  return r;
}

/**
 * Takes one proposal off the list because the PM kept it as their own to-do instead (TODO-5). Nothing reaches the
 * tracker, and its receipt says where it went. Null when it's no longer waiting.
 */
export async function takeProposal(ref: string): Promise<Proposal | null> {
  return withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit } = pick(all, [ref]);
    const p = hit[0];
    if (!p) return null;
    await save(all.filter((x) => x.id !== p.id));
    return p;
  });
}

/** Records in a proposal's receipt that it became the PM's to-do (TODO-5). */
export function markKept(p: Proposal, todo: string, now = new Date()): Promise<void> {
  return markReceipt(p, { todo }, now);
}

/** One proposal as the PM reviews it: what the tracker gets, then (marked) what only this Mac sees. */
export function formatProposal(p: Proposal, n: number, full: boolean, startNow = false): string {
  const head = `${n}. [${p.id}] ${p.title}  (${p.category}, size ${p.size}${p.theme ? `, theme ${p.theme}` : ""}${p.follows ? `, follows ${p.follows.identifier}` : ""})`;
  if (!full) return head;
  const indent = (s: string) => s.split("\n").map((l) => `     ${l}`).join("\n");
  return [
    head,
    `   Linear gets this title, the status ${startNow ? "Todo with start, Backlog with approve" : "Backlog"}, labels pmx-status: ${startNow ? "ready with start, inbox with approve" : "inbox"}, pmx-category, pmx-size${p.theme ? `, pmx-theme: ${p.theme}` : ""}, pmx-state (the status's type, which PMX records), no priority or assignee yet, and this description:`,
    indent(p.description),
    "   Only you see this (it stays on this Mac):",
    ...(p.follows ? [`     · Follows ${p.follows.identifier}: ${p.follows.where === "blocking" ? "a blocking question" : "an open question"} from its accepted draft, ${p.follows.path}${p.follows.more ? ` (${p.follows.more} more ${p.follows.more === 1 ? "question stays" : "questions stay"} there)` : ""}`] : []),
    ...p.from.map((f) => `     · ${f.id} ${f.title} (${f.at.slice(0, 10)}): ${f.why}`),
    ...(changedText(p) ? [`     Changed since it was suggested: ${changedText(p)}`] : []),
  ].join("\n");
}

export function formatProposals(list: Proposal[], full = true, startNow = false): string {
  if (!list.length) return "No new tasks are waiting. `pmx synthesize` suggests some from your recent customer calls.";
  return [
    `${list.length} new task(s) waiting for you. Nothing is in Linear until you approve it.`,
    "",
    ...list.map((p, i) => formatProposal(p, i + 1, full, startNow)).join("\n\n").split("\n"),
    "",
    ...(startNow ? ["Start now (Ready for agents): pmx proposals start <number or ID …> (or --all)"] : []),
    `${startNow ? "Later (to the backlog)" : "Approve"}: pmx proposals approve <number or ID …> (or --all) · Drop: pmx proposals drop <number or ID …> (or --all)`,
    ...(list.some((p) => p.theme) ? ["Theme: pmx proposals theme <number or ID> \"<theme>\" (or none)"] : []),
  ].join("\n");
}
