import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import { packageRoot } from "../core/skills.js";
import { compareVersions, currentVersion } from "../core/version.js";
import { boardStale } from "./board.js";
import { BOARD_SKILL, FLOW_SKILL } from "./skill.js";

/**
 * The pages this Mac published in Claude (FLOW-5, BOARD-1) carry the code of the pmx that made them. PMX can't
 * publish artifacts, so after an update, however it was installed (`pmx update`, the background auto-update or
 * `npm install -g`), PMX tells Claude, and the PM, to publish them again: in the update's output, in what `pmx mcp`
 * tells Claude, on the page itself, in the scheduled collection's report and in `pmx doctor`.
 */
export interface StalePage {
  skill: typeof FLOW_SKILL | typeof BOARD_SKILL;
  title: string;
  url: string;
  publishedVersion: string | null;
  version: string;
}

/**
 * The pmx installed on disk now. `pmx mcp` runs for as long as the Claude app is open, and an npm update replaces the
 * package under it, so this reads package.json each time instead of the running process's version.
 */
export function installedVersion(): string {
  try {
    const v = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
    return typeof v === "string" ? v : currentVersion();
  } catch {
    return currentVersion();
  }
}

/** FLOW-8: a PMX page published with 0.36.0 or later updates itself after a PMX update (it declares `artifact`). */
export const SELF_UPDATE_SINCE = "0.36.0";
export const selfUpdating = (v: string | null | undefined) => !!v && (compareVersions(v, SELF_UPDATE_SINCE) ?? -1) >= 0;

/**
 * The pages this Mac published that Claude has to publish again: the workspace from before 0.36.0 with a pmx other
 * than `version` (a newer one updates itself the next time it's opened), and the team board when its page changed. The team board counts only when this Mac published it:
 * a board someone else shared in pmx.config.json is theirs to update.
 */
export function stalePages(team: Pick<TeamConfig, "board"> | null, personal: Pick<PersonalConfig, "flow" | "board"> | null, version = installedVersion()): StalePage[] {
  const out: StalePage[] = [];
  const f = personal?.flow;
  if (f?.url && f.version !== version && !selfUpdating(f.version)) out.push({ skill: FLOW_SKILL, title: "PMX workspace", url: f.url, publishedVersion: f.version ?? null, version });
  const b = personal?.board;
  if (b?.url && (!team?.board?.url || team.board.url === b.url) && boardStale(b, version))
    out.push({ skill: BOARD_SKILL, title: "PMX team board", url: b.url, publishedVersion: b.version ?? null, version });
  return out;
}

const cmds = (pages: StalePage[]) => pages.map((p) => `/${p.skill}`).join(" and ");

/** One sentence for the PM, on the page or in a notification: what's out of date and what to type. */
export function pageProblem(p: StalePage): string {
  return `Your ${p.title} in Claude was published with pmx ${p.publishedVersion ?? "an older version"}, and this Mac now runs pmx ${p.version}. Type /${p.skill} in the Claude app to update it; it keeps its link.`;
}

/**
 * What PMX prints after an update, for whoever ran it: the PM in Terminal, or Claude, which is then told to publish
 * the pages again itself with PMX's own skills.
 */
export function pagesNote(pages: StalePage[]): string | null {
  if (!pages.length) return null;
  const one = pages.length === 1;
  return [
    `Update your PMX ${one ? "page" : "pages"} in Claude: ${one ? "it still runs" : "they still run"} the code of an older pmx.`,
    ...pages.map((p) => `  • ${p.title} (${p.url}), published with pmx ${p.publishedVersion ?? "an older version"}`),
    `Type ${cmds(pages)} in the Claude app. ${one ? "It keeps its" : "Each keeps its"} link.`,
    `Claude: if you ran this update or were asked to, use the ${pages.map((p) => p.skill).join(" and ")} ${one ? "skill" : "skills"} now to publish ${one ? "it" : "them"} again with the same link, then tell the user.`,
  ].join("\n");
}
