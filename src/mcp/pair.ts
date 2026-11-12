import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { readJson, withLock, writeJson } from "../core/fsutil.js";
import { pmxHome } from "../core/paths.js";

/**
 * Pairing (FLOW-4, PRIV-7): the PM's /pmx-flow page asks `pmx mcp` for a key, PMX asks the PM on this Mac in a native
 * dialog, and only on Allow returns one. The page keeps the key in its own browser storage; PMX keeps only its hash.
 * Every titled read and every action needs a current key, so a Claude chat that can call the server can't read
 * meeting or proposal titles, or act, unless the PM allowed it here.
 */
interface Pairings { v: 1; keys: { hash: string; at: string; lastUsed: string | null }[] }
export const pairingsFile = () => join(pmxHome(), "pairings.json");
const hash = (k: string) => createHash("sha256").update(k).digest("hex");
const MAX = 5;

export type Confirm = () => Promise<boolean>;

export const PAIR_PROMPT = "Your PMX page in the Claude app wants to show your meeting tasks, to-dos and digest, and act on them on this Mac.\n\nAllow it only if you just clicked Connect on your PMX page.";

/** Asks on this Mac with a native dialog. False on Don't Allow, on timeout, or where there's no dialog to show. */
export const macConfirm: Confirm = () => new Promise((resolve) => {
  if (process.platform !== "darwin") return resolve(false);
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display dialog "${esc(PAIR_PROMPT)}" with title "ProductMaxxing" buttons {"Don't Allow", "Allow"} default button "Don't Allow" cancel button "Don't Allow" with icon caution giving up after 120`;
  execFile("/usr/bin/osascript", ["-e", script], { timeout: 130000 }, (err, stdout) => resolve(!err && /button returned:Allow/.test(stdout) && !/gave up:true/.test(stdout)));
});

/** A new key after the PM allows it, or null. Keeps the newest five, so an old page's key ages out. */
export async function pair(confirm: Confirm, now: Date): Promise<string | null> {
  if (!(await confirm())) return null;
  const key = `pmxk_${randomBytes(24).toString("base64url")}`;
  await withLock(pairingsFile(), async () => {
    const p = (await readJson<Pairings>(pairingsFile())) ?? { v: 1, keys: [] };
    p.keys = [...p.keys, { hash: hash(key), at: now.toISOString(), lastUsed: null }].slice(-MAX);
    await writeJson(pairingsFile(), p, 0o600);
  });
  return key;
}

/** Whether `key` is a current one. Compared in constant time. */
export async function keyOk(key: unknown): Promise<boolean> {
  if (typeof key !== "string" || !/^pmxk_[\w-]{20,64}$/.test(key)) return false;
  const p = await readJson<Pairings>(pairingsFile());
  const want = Buffer.from(hash(key), "hex");
  return !!p?.keys.some((k) => { const b = Buffer.from(k.hash, "hex"); return b.length === want.length && timingSafeEqual(b, want); });
}

/** Revokes every key: each paired page shows "Connect" again. Returns how many there were. */
export async function unpairAll(): Promise<number> {
  return withLock(pairingsFile(), async () => {
    const p = (await readJson<Pairings>(pairingsFile())) ?? { v: 1, keys: [] };
    await writeJson(pairingsFile(), { v: 1, keys: [] } satisfies Pairings, 0o600);
    return p.keys.length;
  });
}

export async function pairedCount(): Promise<number> {
  return ((await readJson<Pairings>(pairingsFile()))?.keys ?? []).length;
}
