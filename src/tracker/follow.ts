import { join } from "node:path";
import { privateDir, readJson, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { followComment } from "./states.js";
import type { Tracker } from "./types.js";

/** Tasks PMX already said it leaves alone, by identifier, so each is logged once per reason (TASK-8). */
const leftFile = () => join(paths.home(), "linear", "left.json");

/**
 * TASK-8, the background job's pass over the tracker. Every task is already read the way PMX follows it (toTask), so
 * agents act on a person's move at once; this pass makes Linear agree. It rewrites PMX's label after a move PMX
 * follows, with one short comment; moves the state to match the label where the label decides (an issue from before
 * TASK-7, or a label an older Mac or board changed alone), with no comment; and logs, once,
 * each task it leaves alone (closed in Linear without a review, started by hand). Each write is conditional on the
 * issue still being as PMX read it, so when several Macs follow the same move, only the first one writes.
 */
export async function followMoves(tracker: Tracker): Promise<string[]> {
  const out: string[] = [];
  const left = (await readJson<Record<string, string>>(leftFile())) ?? {};
  const now: Record<string, string> = {};
  let aligned = 0;
  for (const t of await tracker.list()) {
    const w = t.workflow;
    if (!w?.label || !t.status) continue;
    if (w.label !== t.status) {
      await tracker.follow(t.id, { from: w.label, to: t.status, type: w.type, comment: followComment(t.status, w.name) });
      out.push(`${t.identifier} followed a move in Linear${w.name ? ` to ${w.name}` : ""}: ${t.status === "ready" ? "Ready for agents" : "back in the backlog"}`);
    } else if (w.align) {
      if (await tracker.align(t.id, w.label, { type: w.type, recorded: w.recorded })) aligned++;
    } else if (w.held) {
      now[t.identifier] = w.held;
      if (left[t.identifier] !== w.held) out.push(`${t.identifier} left alone: ${w.held}`);
    }
  }
  if (aligned) out.push(`brought ${aligned} task${aligned === 1 ? "'s" : "s'"} Linear status in step with PMX's`);
  if (JSON.stringify(now) !== JSON.stringify(left)) {
    await privateDir(join(paths.home(), "linear"));
    await writeJson(leftFile(), now, 0o600);
  }
  return out;
}
