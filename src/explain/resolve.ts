import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { passageHash, segments, TOPICS, type HoldReason, type PassageCut } from "../core/filter.js";
import { refHash, type RunReceipt } from "../core/receipt.js";
import { parseTranscript } from "../sources/transcripts.js";

export interface LiveSource {
  /** File name and title, found again on this Mac. Shown on screen, never written anywhere. */
  file: string | null;
  title: string | null;
  cuts: LiveCut[];
}

/** One cut, found again: the line it starts on (for a sentence cut, the line of the matched words) and what matched. */
export interface LiveCut {
  rule: HoldReason;
  line: number | null;
  matched: string | null;
  part?: PassageCut["part"];
  followUp?: true;
}

/** A cut that can't be found again on this Mac: its rule and kind only. */
export const unlocated = (c: PassageCut): LiveCut => ({ rule: c.rule, line: null, matched: null, ...(c.part ? { part: c.part } : {}), ...(c.followUp ? { followUp: true as const } : {}) });

const TEXT_EXT = new Set([".md", ".txt", ".vtt", ".srt"]);

/**
 * Finds a receipt's sources again in the PM's own transcript folders (PRIV-4). A receipt stores
 * only hashes for what was left out; this matches them against the files as they are now, so the
 * PM can see which file and which line a rule hit. Nothing it finds is stored.
 */
export async function resolveLive(r: RunReceipt, folders: string[]): Promise<LiveSource[]> {
  const byHash = new Map<string, string>();
  for (const dir of new Set([...r.rules.folders, ...folders])) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (!TEXT_EXT.has(extname(n).toLowerCase()) || n.startsWith(".")) continue;
      const p = join(dir, n);
      if ((await stat(p).catch(() => null))?.isFile()) byHash.set(refHash(p), p);
    }
  }
  const out: LiveSource[] = [];
  for (const s of r.sources) {
    const path = s.kind === "transcript" ? byHash.get(s.refHash) : undefined;
    if (!path) {
      out.push({ file: null, title: null, cuts: s.passagesCut.map(unlocated) });
      continue;
    }
    const raw = await readFile(path, "utf8").catch(() => "");
    const parsed = parseTranscript(raw, basename(path, extname(path)));
    const segs = new Map(segments(parsed.body).map((seg) => [passageHash(seg), seg]));
    const cuts = s.passagesCut.map((c): LiveCut => {
      const seg = segs.get(c.hash);
      if (!seg) return unlocated(c);
      const first = seg.trim().split("\n")[0]!;
      const at = raw.indexOf(first);
      // A reply cut after a passage (F2) matched no rule of its own.
      const hit = c.rule in TOPICS && !c.followUp ? TOPICS[c.rule as keyof typeof TOPICS].exec(seg) : null;
      let line = at < 0 ? null : raw.slice(0, at).split("\n").length;
      // A sentence cut points at the line of the words that matched, not the start of its turn.
      if (line !== null && c.part && hit) line += (seg.slice(seg.length - seg.trimStart().length, hit.index).match(/\n/g) ?? []).length;
      return { ...unlocated(c), line, matched: hit?.[0] ?? null };
    });
    out.push({ file: basename(path), title: parsed.title, cuts });
  }
  return out;
}
