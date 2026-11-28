import { createHash } from "node:crypto";

/**
 * FOLLOW-1: a follow-up's fixed ID. A follow-up is identified by the item of the draft it was read from, never by how
 * PMX words it: the item's own text as the draft's author wrote it, and which of the draft's items with that text it is.
 *
 * Until 0.40.3 a follow-up's key was a hash of PMX's wording of the item ("whether to ship the beta …"), so every
 * improvement to the wording rules could change it, and accepting the same draft again made the follow-up twice. The ID
 * is made here, from the draft's items alone, before the reader words anything (`partsOf` in draft-reader.ts), and this
 * file knows nothing of the reader: no wording rule can reach it. What a follow-up is (a call, a question to ask, work)
 * is PMX's reading too, so it is no part of the ID either: the ledger records it beside the ID.
 *
 * FROZEN: `itemWords`, the hash and its tie-break must never change. A change gives every item a new ID, and each PM
 * who accepts a draft again gets its to-dos twice. test/follow-up-ids.test.ts pins IDs for a draft, so one fails there.
 * What counts as one item (a top-level list item with its nested lines, a paragraph: `blocksOf` in draft-reader.ts) is
 * part of the ID for the same reason, and the same test pins it.
 */

/**
 * An item's own words: letters and digits in lowercase, everything else one space. So emphasis, a list mark, a line
 * break inside the item or a changed dash never makes it another item; a changed word, figure or source ID does.
 */
export const itemWords = (raw: string): string => raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The fixed ID of each of a draft's items, given their texts in the draft's order. Two items with the same words are
 * two items: the second is told from the first by its place among them (the first, the second …), counted over the
 * whole draft.
 */
export function itemIds(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const words = itemWords(text);
    const nth = (seen.get(words) ?? 0) + 1;
    seen.set(words, nth);
    return `f1-${createHash("sha256").update(`pmx follow-up 1\n${words}\n${nth}`).digest("hex").slice(0, 16)}`;
  });
}
