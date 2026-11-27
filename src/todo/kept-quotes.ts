import { join } from "node:path";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import type { EvidencePack } from "../run/packs.js";

/**
 * R16c (TODO-5, RUN-5): a copy of a team task's shared quotes, kept with the to-do it became when the PM took it back,
 * since taking it back removes its pack from the team repo. When the to-do moves to the team again, the new task's pack
 * is written from this copy, checked and swapped like a pack (`packFor`'s kept quotes), so any Mac's agent can draft it,
 * not only the Mac whose run found its sources. On this Mac only (owner-only), by to-do ID, never shown. It goes when
 * the to-do moves to the team or is done.
 */
export interface KeptQuotes {
  quotes: EvidencePack["sources"];
  /** The name swap the pack's passages went through (R5), as a pack's `nameSwap`. */
  quotesSwap?: number;
}

interface Store {
  v: 1;
  todos: Record<string, KeptQuotes & { at: string }>;
}

const file = () => join(paths.staging(), "taken-back-quotes.json");
const read = async (): Promise<Store> => (await readJson<Store>(file())) ?? { v: 1, todos: {} };

async function change(f: (s: Store) => void): Promise<void> {
  await withLock(file(), async () => {
    const s = await read();
    f(s);
    await privateDir(paths.staging());
    await writeJson(file(), s, 0o600);
  });
}

export async function keepQuotes(todoId: string, q: KeptQuotes, now: Date): Promise<void> {
  await change((s) => { s.todos[todoId] = { ...q, at: now.toISOString() }; });
}

export async function quotesFor(todoId: string): Promise<KeptQuotes | null> {
  const k = (await read()).todos[todoId];
  return k ? { quotes: k.quotes, ...(k.quotesSwap ? { quotesSwap: k.quotesSwap } : {}) } : null;
}

export async function dropQuotes(todoId: string): Promise<void> {
  if (!(await read()).todos[todoId]) return;
  await change((s) => { delete s.todos[todoId]; });
}
