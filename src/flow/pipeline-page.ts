import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../core/skills.js";

/** The pipeline board's one page (BOARD-3), shared by `pmx flow --web` and the /pmx-flow artifact. */
export const pipelineTemplate = () => join(packageRoot(), "app-skills", "pmx-flow", "pipeline.html");
const CONFIG_BLOCK = /(<script type="application\/json" id="pmx-config">)[\s\S]*?(<\/script>)/;

/** The page with its config filled in. `<` is escaped so no value can end the script tag. */
export function fillPipeline(template: string, cfg: { mode: "local" | "artifact"; version: string; team: string }): string {
  if (!CONFIG_BLOCK.test(template)) throw new Error("The board page has no config block. Reinstall PMX.");
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return template.replace(CONFIG_BLOCK, (_, open: string, close: string) => `${open}${json}${close}`);
}

/**
 * This Mac's page: a full document whose styles and scripts carry the response's nonce, without the web fonts (the
 * local page loads nothing from outside the Mac; the font stack falls back).
 */
export function localPipelinePage(nonce: string, cfg: { version: string; team: string }, template = readFileSync(pipelineTemplate(), "utf8")): string {
  const body = fillPipeline(template, { mode: "local", ...cfg })
    .replace(/<link [^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\n?/g, "")
    .replace(/<style>/g, `<style nonce="${nonce}">`)
    .replace(/<script(?=[ >])/g, `<script nonce="${nonce}"`);
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="referrer" content="no-referrer">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
