import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { pmxHome } from "../core/paths.js";
import { compareVersions, currentVersion, isVersion } from "../core/version.js";
import { fillPipeline, pipelineTemplate } from "../flow/pipeline-page.js";
import { mcpInstalled } from "../mcp/server.js";
import { ARTIFACT_URL } from "./board.js";
import { claudePresent } from "./skill.js";

/**
 * The pipeline board as a live Claude artifact (FLOW-5, BOARD-3). The page holds no data: it asks the PMX server on the viewer's
 * own Mac (`host:pmx`, `pmx mcp`) through the Claude desktop app, so it shows something only to a PM who opens it
 * on a Mac running PMX, and only at the shared level. PMX can't publish artifacts; `/pmx-flow` does.
 */
export const flowFile = () => join(pmxHome(), "flow", "pmx-flow.html");
/**
 * The page reads PMX through the viewer's own Mac. Unpaired it shows counts and can only add to the do-not-read list
 * (FLOW-6); paired, it is the PM's full workspace (FLOW-4, FLOW-5, BOARD-6).
 */
export const FLOW_TOOLS = ["pipeline", "flow_what_if", "never_ingest_add", "pair", "board", "board_act"] as const;
/**
 * `artifact` (FLOW-8, 0.36.0): after a PMX update the page publishes PMX's newer page over itself, for a viewer who can
 * write it, so it never needs /pmx-flow again unless these capabilities change.
 */
export const flowCapabilities = () => ({ mcp: { servers: [{ server: "host:pmx", tools: [...FLOW_TOOLS] }] }, artifact: {} });

/**
 * The page `/pmx-flow` publishes, exactly: the template with this pmx's version, the team's name and the capabilities
 * it's published with, which the page compares before it publishes a newer one over itself.
 */
export async function flowPageHtml(team: TeamConfig | null): Promise<string> {
  return fillPipeline(await readFile(pipelineTemplate(), "utf8"), { mode: "artifact", version: currentVersion(), team: team?.team ?? "", caps: JSON.stringify(flowCapabilities()) });
}

export async function renderFlow(team: TeamConfig | null, personal: PersonalConfig | null): Promise<string> {
  const html = await flowPageHtml(team);
  await mkdir(join(flowFile(), ".."), { recursive: true });
  await writeFile(flowFile(), html, { mode: 0o644 });
  return flowFile();
}

/** What `/pmx-flow` reads (`pmx flow --publish-json`): the page and exactly how to publish it. */
export async function flowJson(team: TeamConfig | null, personal: PersonalConfig | null) {
  if (!(await claudePresent())) return { ready: false, reason: "Claude isn't set up on this Mac, and the flow view runs inside the Claude app." };
  return {
    ready: true,
    html: await renderFlow(team, personal),
    title: "PMX Workspace",
    description: "Your ProductMaxxing workspace: tasks to approve, to-dos, drafts to review, the digest and settings, run on this Mac through the Claude app.",
    icon: "checklist",
    capabilities: flowCapabilities(),
    url: personal?.flow?.url ?? null,
    publishedVersion: personal?.flow?.version ?? null,
    version: currentVersion(),
    mcpInstalled: await mcpInstalled(),
  };
}

/**
 * FLOW-8: the page published PMX's newer page over itself. Records the version it now runs, keeping its link, as
 * `pmx flow --set-url` would. A version newer than this pmx, or a page this Mac never published, records nothing.
 */
export async function markFlowPublished(personal: PersonalConfig, version: unknown, now: Date): Promise<{ recorded: boolean; why?: string }> {
  if (!isVersion(version) || (compareVersions(version, currentVersion()) ?? 1) > 0) return { recorded: false, why: "that isn't a version this PMX published" };
  if (!personal.flow?.url) return { recorded: false, why: "this Mac has no link for PMX's page in Claude" };
  personal.flow = { url: personal.flow.url, version, publishedAt: now.toISOString() };
  await savePersonalConfig(personal);
  return { recorded: true };
}

export async function setFlowUrl(personal: PersonalConfig, url: string, now: Date): Promise<void> {
  if (!ARTIFACT_URL.test(url)) throw new Error(`"${url}" isn't a Claude artifact link (https://claude.ai/artifact/…).`);
  personal.flow = { url: url.replace(/\/$/, ""), version: currentVersion(), publishedAt: now.toISOString() };
  await savePersonalConfig(personal);
}
