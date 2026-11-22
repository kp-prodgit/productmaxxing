import { removeNeverIngest } from "./settings.js";
import { liveHandlers } from "../flow/pipeline-handlers.js";
import { loadFlowGraph } from "../flow/graph-load.js";
import { trustClaims } from "../flow/graph.js";
import { addNeverIngest, checkNeverIngest, whatIf, type NeverIngestKind } from "../flow/edit.js";
import { exec } from "../core/exec.js";
import { stableNode } from "../core/launchd.js";
import { flowJson, renderFlow, setFlowUrl } from "../claude/flow.js";
import { appSkillTarget, FLOW_SKILL, installAppSkill } from "../claude/skill.js";
import { installMcp, mcpInstalled, serveMcp } from "../mcp/server.js";
import { startExplainServer } from "../explain/server.js";
import { noteWebServer, PAGE_IDLE_MS, runningWebServer, serveUntilStopped } from "../flow/web-server.js";
import type { Command } from "./index.js";
import { savePersonalConfig } from "../core/config.js";
import { engineSource, findPmxe, openStudio } from "../engine/bridge.js";

const hoursOf = (v: string | undefined) => {
  if (v === undefined) return 24;
  const m = String(v).match(/^(\d+)(h|d)?$/);
  if (!m) throw new Error(`--window takes hours or days, like 24h or 7d (up to 14d), not "${v}".`);
  const h = Number(m[1]) * (m[2] === "d" ? 24 : 1);
  if (h < 1 || h > 336) throw new Error("--window must be between 1h and 14d.");
  return h;
};

/**
 * This Mac's PMX page, for `pmx flow --web` and `pmx open`. One per Mac: a second run opens the one already running,
 * so earlier links keep working. On a Mac with PMX Engine the page also has its Strategy area (BOARD-11), read through
 * the bridge and handed to the board here.
 */
async function serveWorkspace(a: Parameters<Command["run"]>[0], noOpen: boolean): Promise<number> {
  const ctx = await a.ctx();
  const running = await runningWebServer();
  if (running) {
    if (!noOpen) await exec("open", [running.url]);
    console.log(`PMX is already serving your board (since ${new Date(running.startedAt).toLocaleString()}, in the Terminal window that started it): ${running.url}\nTo stop it, press Ctrl+C in that window.`);
    return 0;
  }
  // The board reads and saves through a fresh context per request (liveHandlers): this server can run for days.
  const s = await startExplainServer({
    team: ctx.team, personal: ctx.personal,
    flow: async (hours, scope) => loadFlowGraph(await a.ctx(), { level: scope === "team" ? "team" : "local", hours }),
    pipeline: await liveHandlers(a.ctx, { self: "page", cliPath: a.cliPath, engine: engineSource(exec) }),
  });
  const unnote = await noteWebServer(s.flowUrl);
  if (!noOpen) await exec("open", [s.flowUrl]);
  console.log(`PMX pipeline: ${s.flowUrl}\nOnly this Mac can open it. It can approve tasks and change your settings. Running \`pmx open\` or \`pmx flow --web\` again opens this same page. It stops by itself after ${Math.round(PAGE_IDLE_MS / 3600000) || 1} hours with nobody using it. Press Ctrl+C to stop.`);
  // OBS-5: a page nobody uses stops after a while instead of running for days.
  await serveUntilStopped(s, unnote, { log: (l) => console.log(l) });
  return 0;
}

export const flowCommands: Command[] = [
  {
    name: "open",
    summary: "Open your PMX workspace on this Mac. With PMX Engine installed it also has a Strategy area; `pmx open studio` opens the studio itself",
    usage: "pmx open [studio | roadmap] [--no-open] | pmx open --hide-studio | --show-studio",
    options: { "no-open": { type: "boolean" }, "hide-studio": { type: "boolean" }, "show-studio": { type: "boolean" } },
    async run(a) {
      if (a.values["hide-studio"] || a.values["show-studio"]) {
        const ctx = await a.ctx();
        if (a.values["hide-studio"]) ctx.personal.studio = "hidden";
        else delete ctx.personal.studio;
        await savePersonalConfig(ctx.personal);
        console.log(a.values["hide-studio"] ? "PMX Engine's Strategy area is hidden on your PMX page, on this Mac and in the Claude app. `pmxe studio` still opens the studio." : "The Strategy area shows on your PMX page wherever PMX Engine is installed.");
        return 0;
      }
      if (a.positionals[0] === "studio") {
        const p = await findPmxe(exec);
        if (!p) throw new Error("PMX Engine isn't installed on this Mac. It's your team's product lead's tool: they install it with `pmx install --engine`.");
        openStudio(p);
        console.log("Opening PMX Engine's studio in your browser. `pmxe studio` does the same in Terminal.");
        return 0;
      }
      if (a.positionals[0] === "roadmap") {
        const url = (await a.ctx()).team.roadmap?.url;
        if (!url) throw new Error('Your team has no roadmap page yet. The head of product publishes it from PMX Engine and adds its link to pmx.config.json as "roadmap": { "url": "<link>" }.');
        await exec("open", [url]);
        console.log(`Opening your team's roadmap: ${url}`);
        return 0;
      }
      if (a.positionals.length) throw new Error(`pmx open takes "studio", "roadmap" or nothing, not "${a.positionals[0]}".`);
      return serveWorkspace(a, Boolean(a.values["no-open"]));
    },
  },
  {
    name: "flow",
    summary: "The pipeline board: skills, scheduled tasks, what travels from your meetings to Linear and back, and the rules behind it. --web opens it on this Mac",
    usage: "pmx flow [--web [--no-open]] [--window 24h|7d] [--team] [--json] | pmx flow --install-skill | --publish-json | --html | --set-url <link>",
    options: {
      web: { type: "boolean" }, "no-open": { type: "boolean" }, "install-skill": { type: "boolean" }, "publish-json": { type: "boolean" }, html: { type: "boolean" }, "set-url": { type: "string" }, window: { type: "string" }, team: { type: "boolean" }, json: { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill(FLOW_SKILL);
        console.log(r === "kept-yours"
          ? `${appSkillTarget(FLOW_SKILL)} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-flow in the Claude app to publish the flow view.${(await mcpInstalled()) ? "" : " Run `pmx mcp --install` once too, so the page can reach PMX."}`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx();
      if (a.values["publish-json"]) {
        console.log(JSON.stringify(await flowJson(ctx.team, ctx.personal), null, 2));
        return 0;
      }
      if (a.values.html) {
        console.log(await renderFlow(ctx.team, ctx.personal));
        return 0;
      }
      if (a.values["set-url"]) {
        await setFlowUrl(ctx.personal, String(a.values["set-url"]), ctx.now());
        console.log(`Saved. The flow view is ${ctx.personal.flow!.url}`);
        return 0;
      }
      if (a.values.web) return serveWorkspace(a, Boolean(a.values["no-open"]));
      const g = await loadFlowGraph(ctx, { level: a.values.team ? "team" : a.values.json ? "shared" : "local", hours: hoursOf(a.values.window) });
      if (a.values.json) {
        console.log(JSON.stringify(g, null, 2));
        return 0;
      }
      console.log([`Flow for the last ${g.window.hours}h (${g.level === "team" ? "team run log" : "this Mac"}):`, ...trustClaims(g).map((c) => `  ${c}`), ...g.gaps.map((x) => `  · ${x}`)].join("\n"));
      return g.checks.some((c) => c.status === "violated") ? 1 : 0;
    },
  },
  {
    name: "never-ingest",
    summary: "Your do-not-read list: meeting titles, people and channels PMX never reads",
    usage: "pmx never-ingest | pmx never-ingest add --title <text> | --person <name or email> | --channel <name or ID> | pmx never-ingest remove --title <text> | …",
    options: { title: { type: "string" }, person: { type: "string" }, channel: { type: "string" } },
    async run(a) {
      const ctx = await a.ctx();
      const ni = ctx.personal.neverIngest;
      if (a.positionals[0] === "remove") return removeNeverIngest(a);
      if (a.positionals[0] !== "add") {
        console.log([`Titles: ${ni.meetingTitles.join(", ") || "(none)"}`, `People: ${ni.people.join(", ") || "(none)"}`, `Channels: ${ni.channels.join(", ") || "(none)"}`,
          "Only you see this list; run records keep only how many entries it has. Remove an entry with `pmx never-ingest remove`."].join("\n"));
        return 0;
      }
      const given = (["title", "person", "channel"] as NeverIngestKind[]).filter((k) => a.values[k] !== undefined);
      if (given.length !== 1) throw new Error("Give exactly one of --title, --person or --channel.");
      const { kind, value } = checkNeverIngest(given[0]!, a.values[given[0]!]);
      const w = await whatIf(kind, value);
      const r = await addNeverIngest(ctx.personal, kind, value, "cli");
      console.log(r.added ? `Added to your do-not-read list. ${kind === "title" ? `In the last 14 days it would have held ${w.meetings} meeting(s) and ${w.tasks} task(s). ` : ""}${w.note}` : "Already on your do-not-read list.");
      return 0;
    },
  },
  {
    name: "mcp",
    summary: "PMX's server for the /pmx-flow workspace (the Claude app starts it); --install registers it with the Claude desktop app, --unpair disconnects every paired page",
    usage: "pmx mcp | pmx mcp --install [--yes] | pmx mcp --unpair",
    options: { install: { type: "boolean" }, yes: { type: "boolean", short: "y" }, unpair: { type: "boolean" } },
    async run(a) {
      if (a.values.unpair) {
        const { unpairAll } = await import("../mcp/pair.js");
        const n = await unpairAll();
        console.log(n ? `Disconnected ${n} page(s). Each shows Connect again; connecting asks you on this Mac.` : "No page was connected.");
        return 0;
      }
      if (a.values.install) {
        if (!a.values.yes && !(await a.ask.confirm("Register PMX's server with the Claude desktop app, so your /pmx-flow workspace can work on this Mac with nothing running in Terminal? Any Claude chat on this Mac can read PMX's counts and flow metadata (never held meeting titles). Titles and actions need a page you connect, and connecting asks you on this Mac first.", true))) return 1;
        const r = await installMcp(await stableNode(process.execPath), a.cliPath);
        if (r.error) throw new Error(r.error);
        console.log(r.changed ? "Registered. Restart the Claude app, then open your /pmx-flow page there." : "Already registered.");
        return 0;
      }
      // BOARD-11: Engine reaches only the paired page's board and board_act, never the tools a chat may call.
      await serveMcp(() => a.ctx(), { engine: engineSource(exec) });
      return 0;
    },
  },
];
