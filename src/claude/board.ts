import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { pmxHome } from "../core/paths.js";
import { packageRoot } from "../core/skills.js";
import { currentVersion } from "../core/version.js";
import { BOARD_SKILL, claudePresent } from "./skill.js";

/**
 * The team board as a live Claude artifact (BOARD-1). The page reads the team's Linear project through
 * each viewer's own Linear connector, so it needs no hosted app, API key or sign-in, and it works only
 * inside Claude. PMX can't publish artifacts, so it fills in the page and `/pmx-board` publishes it.
 */
export const boardTemplate = () => join(packageRoot(), "app-skills", BOARD_SKILL, "board.html");
export const boardFile = () => join(pmxHome(), "board", "pmx-board.html");

/** The Linear connector tools the page calls. `save_issue` only moves cards between the pool and Ready. */
export const BOARD_TOOLS = ["list_issues", "list_issue_labels", "list_comments", "save_issue"] as const;
/** PMX's own tool the board's owner's page calls on their Mac, to fetch PMX's newer board page (BOARD-1, 0.41.0). */
export const BOARD_SELF_TOOL = "board_page";
/**
 * What the board is published with. `selfUpdate` (0.41.0): also the page's own republish capability (`artifact`) and
 * PMX's server on the viewer's Mac (`host:pmx`, one tool), so the board publishes PMX's newer board page over itself
 * for its owner after a PMX update, as PMX's workspace page does (FLOW-8), and never needs /pmx-board again unless
 * these capabilities change. Without it, the board is as it was before 0.41.0: Linear only.
 */
export const boardCapabilities = (selfUpdate = false) => ({
  mcp: { servers: [{ server: "Linear", tools: [...BOARD_TOOLS] }, ...(selfUpdate ? [{ server: "host:pmx", tools: [BOARD_SELF_TOOL] }] : [])] },
  ...(selfUpdate ? { artifact: {} } : {}),
});
/** A short hash of the capabilities a board was published with, kept with its link. */
export const capsHash = (caps: object) => createHash("sha256").update(JSON.stringify(caps)).digest("hex").slice(0, 16);
/**
 * Whether a board published now can update itself: the Claude app on this Mac has PMX's server, which is where the
 * board's page asks for PMX's newer page. Without it the board is published as before, and says so.
 */
export const boardCanSelfUpdate = (): Promise<boolean> => import("../mcp/server.js").then((m) => m.mcpInstalled()).catch(() => false);
export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+\/?$/;
const CONFIG_BLOCK = /(<script type="application\/json" id="pmx-config">)[\s\S]*?(<\/script>)/;

export type Eligibility = { ok: true } | { ok: false; reason: string };

/** The board is for teams that keep their work in Linear and use Claude on this Mac. */
export function boardEligibility(team: TeamConfig | null, claude: boolean): Eligibility {
  if (!claude) return { ok: false, reason: "Claude isn't set up on this Mac, and the board runs only inside Claude." };
  if (team?.tracker.kind !== "linear") return { ok: false, reason: "pmx.config.json has no Linear project, and the board shows a Linear project." };
  return { ok: true };
}

export async function checkBoard(team: TeamConfig | null): Promise<Eligibility> {
  return boardEligibility(team, await claudePresent());
}

/** The team's shared board (committed in pmx.config.json) wins over the one this PM published. */
export function boardUrl(team: TeamConfig | null, personal: PersonalConfig | null): { url: string; source: "team" | "personal" } | null {
  if (team?.board?.url) return { url: team.board.url, source: "team" };
  if (personal?.board?.url) return { url: personal.board.url, source: "personal" };
  return null;
}

/**
 * Fills the team's Linear project into the page. `<` is escaped so no value can end the script tag. `selfUpdate`: also
 * the page's own hash and the capabilities it's published with, which the page compares before it publishes PMX's
 * newer page over itself; a page without them never tries.
 */
export function fillBoard(template: string, team: TeamConfig, o: { selfUpdate?: boolean } = {}): string {
  if (team.tracker.kind !== "linear") throw new Error("The board needs a Linear project in pmx.config.json.");
  if (!CONFIG_BLOCK.test(template)) throw new Error("The board template has no config block. Reinstall PMX.");
  const self = o.selfUpdate ? { template: createHash("sha256").update(template).digest("hex").slice(0, 16), caps: JSON.stringify(boardCapabilities(true)) } : {};
  const cfg = JSON.stringify({ team: team.team, teamKey: team.tracker.teamKey, projectId: team.tracker.projectId, version: currentVersion(), ...self }).replace(/</g, "\\u003c");
  return template.replace(CONFIG_BLOCK, (_, open: string, close: string) => `${open}${cfg}${close}`);
}

/**
 * Writes the page /pmx-board publishes. Whoever asks (`pmx board --json`, `--html`, `pmx init`), it's the same page for
 * this Mac: one that can update itself where the Claude app has PMX's server, the plain one where it doesn't.
 */
export async function renderBoard(team: TeamConfig, o: { selfUpdate?: boolean } = {}): Promise<string> {
  const html = fillBoard(await readFile(boardTemplate(), "utf8"), team, { selfUpdate: o.selfUpdate ?? (await boardCanSelfUpdate()) });
  await mkdir(join(boardFile(), ".."), { recursive: true });
  await writeFile(boardFile(), html, { mode: 0o644 });
  return boardFile();
}

/** What `/pmx-board` reads (`pmx board --json`): the page to publish and exactly how. */
export async function boardJson(team: TeamConfig | null, personal: PersonalConfig | null) {
  const e = await checkBoard(team);
  const existing = boardUrl(team, personal);
  if (!e.ok || !team) return { ready: false, reason: e.ok ? "No PMX repo found." : e.reason, url: existing?.url ?? null, source: existing?.source ?? null };
  const selfUpdate = await boardCanSelfUpdate();
  return {
    ready: true,
    html: await renderBoard(team, { selfUpdate }),
    title: "PMX Board",
    description: `${team.team}'s PMX pipeline, live from Linear through each viewer's own Linear connector.`,
    icon: "board",
    capabilities: boardCapabilities(selfUpdate),
    // 0.41.0: whether this board updates itself after a PMX update, and what to do when it can't.
    selfUpdate,
    ...(selfUpdate ? {} : { selfUpdateNeeds: "The Claude app on this Mac doesn't have PMX's server, so this board can't fetch PMX's newer page by itself. Run `pmx mcp --install`, restart the Claude app, and type /pmx-board once more." }),
    url: existing?.url ?? null,
    source: existing?.source ?? null,
    publishedVersion: existing?.source === "personal" ? personal?.board?.version ?? null : null,
    version: currentVersion(),
  };
}

/**
 * The board page's own code, by hash (0.36.0). The board reads only Linear, through each viewer's connector, so it has
 * nothing to update after a PMX update unless its page changed: then /pmx-board publishes it again.
 */
export function boardTemplateHash(): string | null {
  try { return createHash("sha256").update(readFileSync(boardTemplate())).digest("hex").slice(0, 16); } catch { return null; }
}

/** Whether the board this PM published runs an older board page. One from before 0.36.0 has no hash: its pmx decides. */
export function boardChanged(board: PersonalConfig["board"], version = currentVersion()): boolean {
  if (!board?.url) return false;
  if (board.template) { const h = boardTemplateHash(); return !!h && h !== board.template; }
  return board.version !== version;
}

/**
 * Whether the board this PM published updates itself (0.41.0): it was published with exactly the capabilities a
 * self-updating board has today. One from before 0.41.0, one published where the Claude app had no PMX server, and one
 * whose capabilities a later PMX changed (a page can't change its own) don't.
 */
export const boardSelfUpdates = (board: PersonalConfig["board"]): boolean => !!board?.caps && board.caps === capsHash(boardCapabilities(true));

/** Whether the board needs /pmx-board typed again: its page changed, and it can't publish the newer one itself. */
export function boardStale(board: PersonalConfig["board"], version = currentVersion()): boolean {
  return boardChanged(board, version) && !boardSelfUpdates(board);
}

/**
 * Whether the board's page changed and the board will publish the newer one itself, the next time its owner opens it
 * in the Claude app on this Mac. Until then teammates see the older page.
 */
export function boardWaits(board: PersonalConfig["board"], version = currentVersion()): boolean {
  return boardChanged(board, version) && boardSelfUpdates(board);
}

export async function setBoardUrl(personal: PersonalConfig, url: string, now: Date): Promise<void> {
  if (!ARTIFACT_URL.test(url)) throw new Error(`"${url}" isn't a Claude artifact link (https://claude.ai/artifact/…).`);
  // The capabilities `pmx board --json` just gave /pmx-board to publish with, worked out the same way.
  const selfUpdate = await boardCanSelfUpdate();
  personal.board = { url: url.replace(/\/$/, ""), version: currentVersion(), publishedAt: now.toISOString(), template: boardTemplateHash() ?? undefined, ...(selfUpdate ? { caps: capsHash(boardCapabilities(true)) } : {}) };
  await savePersonalConfig(personal);
}

/**
 * What PMX's server answers the board's own page (`board_page`, BOARD-1, 0.41.0). The page says which Linear project
 * it shows and the hash of the page it runs. Only the board this Mac published for that project gets an answer with
 * anything in it: PMX's board page as /pmx-board would publish it now, when it differs from the page that asked, or
 * that it's current, and then PMX records the page the board now runs, keeping its link. Anything else (another
 * team's board, a board a teammate published, a Mac without a board) is told only that it isn't this Mac's.
 */
export async function boardPage(team: TeamConfig | null, personal: PersonalConfig, args: { project?: unknown; have?: unknown }, now: Date): Promise<Record<string, unknown>> {
  const mine = !!personal.board?.url && (!team?.board?.url || team.board.url === personal.board.url);
  if (!team || team.tracker.kind !== "linear" || !mine || typeof args.project !== "string" || args.project !== team.tracker.projectId) return { yours: false };
  const template = boardTemplateHash();
  if (!template) return { yours: false };
  const version = currentVersion();
  if (args.have === template) {
    if (personal.board!.template !== template) {
      personal.board = { ...personal.board!, version, publishedAt: now.toISOString(), template };
      await savePersonalConfig(personal);
    }
    return { yours: true, current: true, version, template };
  }
  return { yours: true, current: false, version, template, html: fillBoard(await readFile(boardTemplate(), "utf8"), team, { selfUpdate: true }), capabilities: boardCapabilities(true) };
}

export function formatBoard(team: TeamConfig | null, personal: PersonalConfig | null, e: Eligibility, skill: boolean): string {
  const existing = boardUrl(team, personal);
  if (!e.ok) return `No Claude board for this team: ${e.reason}`;
  const lines: string[] = [];
  if (existing) {
    lines.push(`Team board: ${existing.url}`, existing.source === "team" ? "(shared in pmx.config.json)" : "(published from this Mac)");
    if (existing.source === "personal" && boardStale(personal?.board))
      lines.push("", `It was published with pmx ${personal?.board?.version ?? "an older version"}, and the board's page has changed since. Type /pmx-board in the Claude app to update it; it keeps its link.${personal?.board?.caps ? "" : " From then on it updates itself."}`);
    else if (existing.source === "personal" && boardWaits(personal?.board))
      lines.push("", "The board's page changed in a PMX update. Open the board in the Claude app on this Mac and it updates itself, for your teammates too; it keeps its link.");
    else if (existing.source === "personal" && boardSelfUpdates(personal?.board)) lines.push("", "It updates itself after a PMX update, the next time you open it in the Claude app on this Mac.");
    else if (existing.source === "personal") lines.push("", "It needs /pmx-board again only when a PMX update changes the board's page; PMX says so when one does.");
    if (existing.source === "personal")
      lines.push("", "To give teammates the same board, share it from the artifact's Share menu, then add it to pmx.config.json in a PR:", `  "board": { "url": "${existing.url}" }`);
    return lines.join("\n");
  }
  lines.push("This team has no Claude board yet.");
  lines.push(skill
    ? "Open the Claude desktop app (Code tab), start a session and type /pmx-board. Claude publishes the board as a live artifact in your account."
    : "Run `pmx board --install-skill` once to add a /pmx-board command to your Claude app, then type /pmx-board there.");
  lines.push("Everyone who opens it sees the Linear project through their own Linear connector, so each person needs Linear connected in Claude.");
  return lines.join("\n");
}
