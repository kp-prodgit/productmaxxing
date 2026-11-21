import { join } from "node:path";
import type { Ctx } from "../core/context.js";
import { readJson, writeJson } from "../core/fsutil.js";
import { outputHost } from "../core/host.js";
import { paths } from "../core/paths.js";
import type { PipelineData } from "./pipeline.js";

/**
 * Team settings pull requests opened from the board (BOARD-3), so the board can say "in review" until one merges or
 * closes. Kept on this Mac only; checked against GitHub at most every five minutes.
 */
interface Stored { id: string; url: string; at: string; changes: string[] }
const file = () => join(paths.home(), "settings-prs.json");
let checked: { at: number; open: Stored[] } | null = null;

export async function rememberTeamPr(pr: Stored): Promise<void> {
  const list = (await readJson<Stored[]>(file())) ?? [];
  await writeJson(file(), [...list.filter((p) => p.id !== pr.id), pr]);
  checked = null;
}

/** Drops one from the list once it's applied (BOARD-9), without waiting for the next check. */
export async function forgetTeamPr(id: string): Promise<void> {
  const list = (await readJson<Stored[]>(file())) ?? [];
  await writeJson(file(), list.filter((p) => p.id !== id));
  checked = null;
}

export async function pendingTeamPrs(ctx: Pick<Ctx, "repo" | "keychain" | "exec" | "fetch">): Promise<PipelineData["pendingTeam"]> {
  const list = (await readJson<Stored[]>(file())) ?? [];
  if (!list.length) return [];
  if (!checked || Date.now() - checked.at > 300000) {
    let open = list;
    try {
      const host = await outputHost(ctx.repo, ctx.keychain, ctx.exec, ctx.fetch);
      const still = await Promise.all(list.map((p) => host.isOpen(p.id).catch(() => true)));
      open = list.filter((_, k) => still[k]);
      if (open.length !== list.length) await writeJson(file(), open);
    } catch {
      // Offline or no GitHub access: keep showing them rather than claim they merged.
    }
    checked = { at: Date.now(), open };
  }
  return checked.open.map(({ url, at, changes }) => ({ url, at, changes }));
}
