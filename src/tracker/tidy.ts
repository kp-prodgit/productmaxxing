import type { Task } from "../core/types.js";
import { meetingTitle, type MeetingEntry, type Tracker } from "./types.js";

/**
 * Taking back what PMX wrote to the tracker (TIDY-1). Before 0.14.0 a task's description quoted the meetings it came
 * from, and a processed meeting was lodged under its own title. `pmx linear tidy` rewrites both to what PMX writes
 * now; `pmx linear withdraw` cancels an issue and blanks its description. Nothing is ever deleted.
 */
export interface Written {
  identifier: string;
  id: string;
  kind: "task" | "meeting";
  title: string;
  /** What needs taking back, in words; empty when the issue is already in today's form. */
  problems: string[];
  fix: { title?: string; description?: string } | null;
}

const EXCERPT = /^- \[[TS]\d+\] .*$/gm;

/** A task description without the quoted meeting excerpts older versions wrote. Null when there were none. */
export function scrubTask(description: string): string | null {
  if (!/^\*\*Sources\*\*[ \t]*$/m.test(description) && !EXCERPT.test(description)) return null;
  EXCERPT.lastIndex = 0;
  const n = (description.match(EXCERPT) ?? []).length;
  const kept = description.replace(EXCERPT, "").replace(/^\*\*Sources\*\*[ \t]*$/m, `**Based on** ${n === 1 ? "one source" : `${n} sources`}. The sources stay on the PM's Mac.`);
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}

/** A meeting entry in today's form: an opaque title and only its identity and task lines. Null when it already is. */
export function scrubMeeting(m: MeetingEntry, description: string | null): { title: string; description: string } | null {
  const title = meetingTitle(m);
  const neutral = [
    "PMX processed a meeting and marks it here so no teammate processes it twice (MEET-2). Not a task, and it holds no meeting details.", "",
    ...(m.agent ? [`Processed by: ${m.agent}`, ""] : []), ...m.keys.map((k) => `pmx:meeting ${k}`), ...m.tasks.map((t) => `pmx:task ${t}`),
  ].join("\n");
  // Today's entries name only a date and who processed it, and PMX reads only these lines back.
  const fine = (description ?? "").split("\n").every((l) => !l.trim() || /^(pmx:(meeting|task) |Processed by: |PMX (processed|marks))/.test(l));
  return m.title === title && fine ? null : { title, description: neutral };
}

/** Everything PMX wrote to the project, and what in it needs taking back. */
export async function writtenByPmx(tracker: Tracker): Promise<Written[]> {
  const tasks = (await tracker.list()).filter((t: Task) => t.status !== null || t.sources.length);
  const out: Written[] = tasks.map((t) => {
    const description = scrubTask(t.description);
    return { identifier: t.identifier, id: t.id, kind: "task", title: t.title, problems: description ? ["its description quotes the meetings it came from"] : [], fix: description ? { description } : null };
  });
  for (const m of await tracker.listMeetings()) {
    const full = await tracker.get(m.id).catch(() => null);
    const fix = scrubMeeting(m, full?.description ?? null);
    const problems = fix ? [m.title !== meetingTitle(m) ? "its title is the meeting's own title" : "its description names more than PMX needs"] : [];
    out.push({ identifier: m.identifier, id: m.id, kind: "meeting", title: m.title, problems, fix });
  }
  return out;
}

export const WITHDRAWN = "Withdrawn by the PM through PMX. Its text was removed; Linear may still keep earlier versions in the issue's history.";
