import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { pmxHome } from "../core/paths.js";
import { currentVersion } from "../core/version.js";
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
/** The page reads PMX through the viewer's own Mac and can only add to the do-not-read list (BOARD-3, FLOW-6). */
export const FLOW_TOOLS = ["pipeline", "flow_what_if", "never_ingest_add"] as const;
export const flowCapabilities = () => ({ mcp: { servers: [{ server: "host:pmx", tools: [...FLOW_TOOLS] }] } });

export async function renderFlow(team: TeamConfig | null, personal: PersonalConfig | null): Promise<string> {
  const html = fillPipeline(await readFile(pipelineTemplate(), "utf8"), { mode: "artifact", version: currentVersion(), team: team?.team ?? "" });
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
    title: "PMX Pipeline",
    description: "ProductMaxxing's pipeline: skills, scheduled tasks, what travels from your meetings to Linear and back, and the rules behind each step, read from this Mac.",
    icon: "flow",
    capabilities: flowCapabilities(),
    url: personal?.flow?.url ?? null,
    publishedVersion: personal?.flow?.version ?? null,
    version: currentVersion(),
    mcpInstalled: await mcpInstalled(),
  };
}

export async function setFlowUrl(personal: PersonalConfig, url: string, now: Date): Promise<void> {
  if (!ARTIFACT_URL.test(url)) throw new Error(`"${url}" isn't a Claude artifact link (https://claude.ai/artifact/…).`);
  personal.flow = { url: url.replace(/\/$/, ""), version: currentVersion(), publishedAt: now.toISOString() };
  await savePersonalConfig(personal);
}
