import { draftItems } from "../draft-reader.js";
import { followUpItems, plain } from "./draft-reader-0403.js";

/**
 * LEGACY (FOLLOW-1): the keys PMX 0.40.3 and earlier wrote to the follow-ups ledger, for a draft accepted then and
 * accepted again now.
 *
 * Until 0.40.3 the ledger on each PM's Mac recorded a follow-up as made under a hash of PMX's own wording of it. Since
 * 0.41.0 a follow-up has a fixed ID, its item in the draft (src/review/follow-up-id.ts), and the ledger records that.
 * The old keys are still on PMs' Macs, with nothing beside them that says which item each was. The only thing that
 * gives one back is the 0.40.3 reader, so a frozen copy of it is kept (./draft-reader-0403.ts) and read here, and
 * nowhere else: given the draft being accepted, it says which old key or keys 0.40.3 gave each of its items. Accepting
 * (src/review/followups.ts) then knows an item whose old key the ledger has was made already, and records its fixed
 * ID, so from then on the old key is never needed for it again.
 *
 * Why at the accept, and not once in an update step: the accept always has the draft in hand, with the task's title
 * (which the wording could lean on), on whatever PMX the Mac moved to, however many versions later. An update step
 * could only read the drafts that happen to be in the team repo on this Mac that day, without their task.
 *
 * An item is matched to its old key by its own text, as 0.40.3 read it (its `plain`). Two items with the same text
 * share their old keys: the old keys never told them apart either. Never throws: without old keys, accepting still
 * has the fixed IDs and its checks against open to-dos and task titles.
 */
export function legacyKeys(markdown: string, identifier: string, now: Date, task: { title?: string | null } = {}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  try {
    const byText = new Map<string, Set<string>>();
    for (const item of followUpItems(markdown, identifier, now, task)) {
      const key = item.decision?.key ?? item.question?.key;
      if (key) byText.set(item.text, (byText.get(item.text) ?? new Set()).add(key));
    }
    if (!byText.size) return out;
    for (const item of draftItems(markdown)) {
      const keys = byText.get(plain(item.text));
      if (keys) out.set(item.id, [...keys]);
    }
  } catch { /* The fixed IDs and the nets still stand. */ }
  return out;
}
