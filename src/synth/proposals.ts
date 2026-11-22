import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import { startsNow } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt, writeReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import type { Size } from "../core/types.js";
import { openThemes, themeNamed } from "./themes.js";

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
  again?: { receipt: string; at: string; n: number }[];
  /**
   * A roadmap theme from the team's memory/engine/themes.json (EQ-38), suggested by synthesis or set by the PM. It
   * becomes a pmx-theme label only if the theme is still open when the PM approves.
   */
  theme?: string;
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

/**
 * Adds a later run's sources to a proposal still waiting (INPUT-2): the same need, heard again. The PM sees every
 * source under the proposal, and the description Linear would get says how many more sources and when, never which.
 * False when the proposal is gone (approved or dropped since).
 */
export async function addEvidence(id: string, e: { receipt: string; from: Proposal["from"]; days: string[] }): Promise<boolean> {
  return withLock(proposalsFile(), () => evidenceLocked(id, e));
}

async function evidenceLocked(id: string, e: { receipt: string; from: Proposal["from"]; days: string[] }): Promise<boolean> {
  const all = await readProposals();
  const p = all.find((x) => x.id === id);
  if (!p) return false;
  const seen = new Set(p.from.map((f) => `${f.title}|${f.at}`));
  const fresh = e.from.filter((f) => !seen.has(`${f.title}|${f.at}`));
  if (!fresh.length) return true;
  p.from = [...p.from, ...fresh.map((f) => ({ ...f, id: `${f.id}@${e.receipt}` }))];
  p.again = [...(p.again ?? []), { receipt: e.receipt, at: new Date().toISOString(), n: fresh.length }];
  const more = p.again.reduce((a, x) => a + x.n, 0);
  const days = [...new Set([...(p.description.match(/^\*\*Heard again\*\*.*\(([^)]*)\)\.$/m)?.[1]?.split(", ") ?? []), ...e.days])].sort().join(", ");
  const line = `**Heard again** in ${more === 1 ? "one more source" : `${more} more sources`} (${days}).`;
  p.description = /^\*\*Heard again\*\*.*$/m.test(p.description)
    ? p.description.replace(/^\*\*Heard again\*\*.*$/m, line)
    : p.description.replace(/^(\*\*Based on\*\*.*)$/m, `$1\n${line}`);
  if (hasCanary(JSON.stringify(p))) throw new Error(CANARY_REFUSAL);
  await save(all);
  return true;
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
export const START_OFF = "Your team has a teammate decide what agents take, so Start now is off: approve the task and it waits in the backlog until a teammate moves it to Ready.";

/**
 * Writes the chosen proposals to the tracker, exactly as staged, and takes them off the list. By default each goes to
 * the pool (inbox). `start` is the PM's Start now (APPROVE-3): the same text, created straight in Ready, and only when
 * the team allows it. This is the only way a Ready task is created; synthesis itself only ever stages proposals.
 */
export async function approveProposals(ctx: Ctx, svc: Services, refs: string[], o: { start?: boolean } = {}): Promise<{ posted: { id: string; identifier: string; title: string; theme?: string; ready: boolean }[]; duplicates: string[]; missing: string[]; unthemed: string[] }> {
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
    }
    done.add(p.id);
    // Saved after each one, so a failure halfway never posts the same task twice.
    await withLock(proposalsFile(), async () => save((await readProposals()).filter((x) => !done.has(x.id))));
  }
  return { posted, duplicates, missing, unthemed };
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
  if (o.startNow) return `Approved ${ids} for later: ${one ? "it waits" : "they wait"} in your team's backlog in Linear${sync ? " from the next Claude sync" : ""}. When you want an agent on ${one ? "it" : "one"}, move it to Ready on the team board.`;
  return `Approved ${ids}: ${one ? "it goes" : "they go"} to your team's backlog in Linear${sync ? " at the next Claude sync" : ""}. An agent takes ${one ? "it" : "one"} only after a teammate moves it to Ready.`;
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
  const head = `${n}. [${p.id}] ${p.title}  (${p.category}, size ${p.size}${p.theme ? `, theme ${p.theme}` : ""})`;
  if (!full) return head;
  const indent = (s: string) => s.split("\n").map((l) => `     ${l}`).join("\n");
  return [
    head,
    `   Linear gets this title, labels pmx-status: ${startNow ? "ready with start, inbox with approve" : "inbox"}, pmx-category, pmx-size${p.theme ? `, pmx-theme: ${p.theme}` : ""}, and this description:`,
    indent(p.description),
    "   Only you see this (it stays on this Mac):",
    ...p.from.map((f) => `     · ${f.id} ${f.title} (${f.at.slice(0, 10)}): ${f.why}`),
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
