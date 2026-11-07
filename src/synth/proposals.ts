import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt, writeReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import type { Size } from "../core/types.js";

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
async function markReceipt(p: Proposal, posted: { identifier: string } | { dropped: true } | { duplicateOf: string }, now: Date): Promise<void> {
  const r = await readReceipt(p.receipt);
  const t = r?.synth?.tasks.find((x) => x.posted && "staged" in x.posted && x.posted.staged === p.id);
  if (!r || !t) return;
  t.posted = posted;
  await writeReceipt(r, now);
}

/** Writes the chosen proposals to the tracker's inbox, exactly as staged, and takes them off the list. */
export async function approveProposals(ctx: Ctx, svc: Services, refs: string[]): Promise<{ posted: { id: string; identifier: string; title: string }[]; duplicates: string[]; missing: string[] }> {
  const all = await readProposals();
  const { hit, missing } = pick(all, refs);
  const open = new Map((await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => [norm(t.title), t.identifier]));
  const posted: { id: string; identifier: string; title: string }[] = [];
  const duplicates: string[] = [];
  const done = new Set<string>();
  for (const p of hit) {
    const dup = open.get(norm(p.title));
    if (dup) {
      duplicates.push(`${p.title} (already ${dup})`);
      await markReceipt(p, { duplicateOf: dup }, ctx.now());
    } else {
      const t = await svc.tracker.createInbox({ title: p.title, description: p.description, category: p.category, size: p.size, sources: p.sources });
      posted.push({ id: p.id, identifier: t.identifier, title: t.title });
      open.set(norm(p.title), t.identifier);
      await markReceipt(p, { identifier: t.identifier }, ctx.now());
    }
    done.add(p.id);
    // Saved after each one, so a failure halfway never posts the same task twice.
    await save((await readProposals()).filter((x) => !done.has(x.id)));
  }
  return { posted, duplicates, missing };
}

export async function dropProposals(refs: string[], now = new Date()): Promise<{ dropped: Proposal[]; missing: string[] }> {
  const all = await readProposals();
  const { hit, missing } = pick(all, refs);
  for (const p of hit) await markReceipt(p, { dropped: true }, now);
  const gone = new Set(hit.map((p) => p.id));
  await save(all.filter((p) => !gone.has(p.id)));
  return { dropped: hit, missing };
}

/** One proposal as the PM reviews it: what the tracker gets, then (marked) what only this Mac sees. */
export function formatProposal(p: Proposal, n: number, full: boolean): string {
  const head = `${n}. [${p.id}] ${p.title}  (${p.category}, size ${p.size})`;
  if (!full) return head;
  const indent = (s: string) => s.split("\n").map((l) => `     ${l}`).join("\n");
  return [
    head,
    "   Linear gets this title, labels pmx-status: inbox, pmx-category, pmx-size, and this description:",
    indent(p.description),
    "   Only you see this (it stays on this Mac):",
    ...p.from.map((f) => `     · ${f.id} ${f.title} (${f.at.slice(0, 10)}): ${f.why}`),
  ].join("\n");
}

export function formatProposals(list: Proposal[], full = true): string {
  if (!list.length) return "No proposed tasks are waiting. `pmx synthesize` proposes some from your recent customer calls.";
  return [
    `${list.length} proposed task(s) waiting for you. Nothing is in Linear until you approve it.`,
    "",
    ...list.map((p, i) => formatProposal(p, i + 1, full)).join("\n\n").split("\n"),
    "",
    "Approve: pmx proposals approve <number or ID …> (or --all) · Drop: pmx proposals drop <number or ID …> (or --all)",
  ].join("\n");
}
