import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { VERSIONED_NODE } from "../core/launchd.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Ctx } from "../core/context.js";
import { currentVersion } from "../core/version.js";
import { stalePages } from "../claude/pages.js";
import { handoff, noteServer, type HandoffDeps } from "./handoff.js";
import { addNeverIngest, checkNeverIngest, whatIf } from "../flow/edit.js";
import { loadFlowGraph } from "../flow/graph-load.js";
import { loadPipeline } from "../flow/pipeline-load.js";
import { ACT_PATHS, pipelineAct, type PipelineActions } from "../flow/pipeline-act.js";
import { keyOk, macConfirm, pair, unpairAll, type Confirm } from "./pair.js";

/**
 * `pmx mcp` (FLOW-4): a local MCP server on stdio, so the /pmx-flow artifact can reach PMX through the Claude app
 * (`host:pmx`). Hand-rolled JSON-RPC 2.0, one message per line, no dependencies.
 *
 * Any Claude chat on this Mac can call it. Without a key it answers at the "shared" level only: held items are a rule
 * and a number, never a title, file, hash or detail; private to-dos are a count; its one write only tightens the PM's
 * do-not-read list. With a key from `pair`, which the PM allows on this Mac in a native dialog, `board` and `board_act`
 * are the PM's full board, as `pmx flow --web` serves it (PRIV-7). PMX's own agent runs use `--strict-mcp-config` with
 * no servers, so they never see it.
 */
const KEY = { type: "string", description: "The key this page got from pair. Kept by the page; never ask the user for it." } as const;
export const MCP_TOOLS = [
  {
    name: "pipeline",
    description: "ProductMaxxing (PMX) pipeline board: counts of meetings and Slack threads read, held and sent to Claude, tasks proposed and sent to Linear, agent runs and reviews in a time window, plus the skills, scheduled tasks, rules and privacy checks. Counts only: no meeting or proposal titles, no do-not-read entries.",
    inputSchema: { type: "object", additionalProperties: false, properties: { hours: { type: "integer", minimum: 1, maximum: 336, description: "How far back to look (default 168, a week)." } } },
    annotations: { title: "PMX pipeline", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "flow_graph",
    description: "ProductMaxxing (PMX) flow: the meetings and Slack threads PMX read or held (held ones by rule only), the runs, skills, proposed tasks, Linear issues, agent runs, reviews and spend in a time window, plus the privacy checks. Metadata only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { hours: { type: "integer", minimum: 1, maximum: 336, description: "How far back to look (default 24)." }, scope: { type: "string", enum: ["mine", "team"], description: "This Mac, or the team's shared run log." } },
    },
    annotations: { title: "PMX flow graph", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "flow_what_if",
    description: "How many meetings and PMX tasks in the last 14 days a new do-not-read title would have held. Changes nothing.",
    inputSchema: { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { type: "string", enum: ["title", "person", "channel"] }, value: { type: "string", minLength: 3, maxLength: 120 } } },
    annotations: { title: "Preview a PMX do-not-read rule", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "never_ingest_add",
    description: "Adds a meeting title, person or channel to the PM's ProductMaxxing do-not-read list, so PMX never reads matching meetings again. Only adds; removing an entry is done in Terminal.",
    inputSchema: { type: "object", additionalProperties: false, required: ["kind", "value"], properties: { kind: { type: "string", enum: ["title", "person", "channel"] }, value: { type: "string", minLength: 3, maxLength: 120 } } },
    annotations: { title: "Add to the PMX do-not-read list", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "pair",
    description: "Connects the PM's own /pmx-flow page to ProductMaxxing (PMX) on this Mac. PMX asks the PM in a dialog on the Mac and returns a key only if they allow it. For the page's Connect button only: never call it from a chat.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { title: "Connect a PMX page", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "board",
    description: "The PM's full ProductMaxxing (PMX) board for their paired /pmx-flow page: proposals, to-dos, drafts, the digest, settings. Needs the page's key; refuses without it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["key"], properties: { key: KEY, hours: { type: "integer", minimum: 1, maximum: 336 } } },
    annotations: { title: "PMX board (paired page)", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "board_act",
    description: "One action from the PM's paired /pmx-flow page: approve or drop proposals, tick, add or move a to-do, decide a draft review, approve the digest, run a step, change settings. Needs the page's key; refuses without it.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["key", "path", "body"],
      properties: { key: KEY, path: { type: "string", enum: [...ACT_PATHS, "unpair"] }, body: { type: "object" } },
    },
    annotations: { title: "Act on the PMX board (paired page)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
] as const;

const INSTRUCTIONS = "ProductMaxxing (PMX) for the PM's /pmx-flow page. In a chat, use only pipeline, flow_graph and flow_what_if (counts and metadata). pair, board and board_act are for the page itself: never call pair from a chat, and never ask the user for a key.";
const REPUBLISH = "PMX can't publish its pages in Claude itself, so after PMX is updated they keep running the older code until Claude publishes them again. When the pipeline tool's health problems say a PMX page in Claude was published with an older pmx, tell the user and offer to update it now with the pmx-flow skill (the workspace) or the pmx-board skill (the team board); each keeps its link.";

/**
 * What the Claude app tells Claude about this server when it starts it. After an update, it names the pages this Mac
 * published with an older pmx, so Claude offers to publish them again.
 */
export async function serverInstructions(ctx: () => Promise<Ctx>): Promise<string> {
  const pages = await ctx().then((c) => stalePages(c.team, c.personal), () => []);
  const now = pages.map((p) => `Right now, the user's ${p.title} was published with pmx ${p.publishedVersion ?? "an older version"} and pmx ${p.version} is installed: tell the user once, briefly, and offer to update it with the ${p.skill} skill.`);
  return [INSTRUCTIONS, REPUBLISH, ...now].join(" ");
}

type Msg = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

/** What a paired call needs besides the context: the board's actions and how to ask the PM. Tests pass their own. */
export interface McpDeps { actions?: (c: Ctx) => PipelineActions; confirm?: Confirm }
const NOT_PAIRED = { error: "This page isn't connected to PMX on this Mac. Click Connect on the page.", code: "not_paired" };

/** Answers one JSON-RPC message, or null for a notification. Exported for tests. */
export async function handleMcp(msg: Msg, ctx: () => Promise<Ctx>, deps: McpDeps = {}): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
        // listChanged: after an update hands off to a newer pmx, its tools may differ (see handoff.ts).
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "pmx", title: "ProductMaxxing", version: currentVersion() },
        instructions: await serverInstructions(ctx),
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const result = (data: object, isError = false) => reply({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError });
      try {
        if (name === "pipeline") {
          const hours = args.hours === undefined ? 168 : Number(args.hours);
          if (!Number.isInteger(hours) || hours < 1 || hours > 336) return result({ error: "hours must be a whole number from 1 to 336" }, true);
          const c = await ctx();
          return result(await loadPipeline(c, { level: "shared", hours, keychain: c.keychain }));
        }
        if (name === "flow_graph") {
          const hours = args.hours === undefined ? 24 : Number(args.hours);
          if (!Number.isInteger(hours) || hours < 1 || hours > 336) return result({ error: "hours must be a whole number from 1 to 336" }, true);
          const graph = await loadFlowGraph(await ctx(), { level: args.scope === "team" ? "team" : "shared", hours });
          return result(graph);
        }
        if (name === "flow_what_if") {
          const { kind, value } = checkNeverIngest(String(args.kind), args.value);
          return result(await whatIf(kind, value));
        }
        if (name === "never_ingest_add") {
          const { kind, value } = checkNeverIngest(String(args.kind), args.value);
          const r = await addNeverIngest((await ctx()).personal, kind, value, "flow");
          return result({ added: r.added, message: r.added ? "Added to your do-not-read list. PMX applies it from the next run." : "Already on your do-not-read list." });
        }
        if (name === "pair") {
          const key = await pair(deps.confirm ?? macConfirm, new Date());
          return key ? result({ key, message: "Connected. This page can now show your board and act on it." }) : result({ error: "Not connected: you chose Don't Allow on the Mac, or nobody answered.", code: "declined" }, true);
        }
        if (name === "board" || name === "board_act") {
          if (!(await keyOk(args.key))) return result(NOT_PAIRED, true);
          const c = await ctx();
          const actions = (deps.actions ?? (await import("../flow/pipeline-handlers.js")).pipelineHandlers)(c);
          if (name === "board") {
            const hours = args.hours === undefined ? 168 : Number(args.hours);
            if (!Number.isInteger(hours) || hours < 1 || hours > 336) return result({ error: "hours must be a whole number from 1 to 336" }, true);
            return result(await actions.data(hours));
          }
          const path = String(args.path ?? "");
          if (path === "unpair") return result({ status: 200, body: { message: `Disconnected ${await unpairAll()} page(s). Each shows Connect again.` } });
          const [status, body] = await pipelineAct(actions, path, args.body);
          return result({ status, body });
        }
        return fail(-32602, `Unknown tool ${name}`);
      } catch (e: any) {
        return result({ error: String(e?.message ?? e) }, true);
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Serves MCP on stdin/stdout until stdin closes. Nothing else may write to stdout meanwhile. */
export async function serveMcp(ctx: () => Promise<Ctx>, deps: McpDeps = {}, io: { input?: NodeJS.ReadableStream; write?: (line: string) => void; handoff?: HandoffDeps } = {}): Promise<void> {
  console.log = (...a: unknown[]) => console.error(...a);
  const write = io.write ?? ((l: string) => void process.stdout.write(`${l}\n`));
  // After an update, the newly installed pmx answers instead of this process's old code (see handoff.ts).
  const h = handoff(write, io.handoff);
  const unnote = io.input ? async () => {} : await noteServer();
  const rl = createInterface({ input: io.input ?? process.stdin, crlfDelay: Infinity });
  try {
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (h.route(line)) continue;
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    // Answered as each finishes, not in order: a pairing dialog or a Linear write mustn't hold up the page's reads.
    void handleMcp(msg, ctx, deps).then((out) => { if (out) write(JSON.stringify(out)); });
  }
  } finally {
    h.close();
    await unnote();
  }
}

/** The Claude desktop app's MCP config. Tests point PMX_CLAUDE_DESKTOP_CONFIG elsewhere. */
export const desktopConfig = () => process.env.PMX_CLAUDE_DESKTOP_CONFIG ?? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");

/** Whether the Claude desktop app is on this Mac: its settings folder exists. */
export async function desktopAppPresent(): Promise<boolean> {
  return stat(dirname(desktopConfig())).then((s) => s.isDirectory(), () => false);
}

/** The command the Claude app runs for PMX's server, or null when it isn't registered. */
export async function mcpEntry(): Promise<{ command: string; args: string[] } | null> {
  const raw = await readFile(desktopConfig(), "utf8").catch(() => null);
  try { const e = raw ? JSON.parse(raw)?.mcpServers?.pmx : null; return e && typeof e.command === "string" ? { command: e.command, args: Array.isArray(e.args) ? e.args : [] } : null; } catch { return null; }
}

/**
 * Whether the registered server can still start: its Node and pmx exist, and its Node isn't a versioned Homebrew folder
 * that `brew upgrade node` removes. Null when it isn't registered.
 */
export async function mcpHealth(): Promise<{ ok: boolean; detail: string } | null> {
  const e = await mcpEntry();
  if (!e) return null;
  const exists = (f: string) => stat(f).then(() => true, () => false);
  const gone = [e.command, e.args[0] ?? ""].filter(Boolean);
  for (const f of gone) if (!(await exists(f))) return { ok: false, detail: `the Claude app starts PMX's server with ${f}, which no longer exists, so /pmx-flow can't reach PMX: run \`pmx mcp --install\`, then restart the Claude app` };
  if (VERSIONED_NODE.test(e.command)) return { ok: false, detail: `the Claude app starts PMX's server with Node from a versioned Homebrew folder (${e.command}); \`brew upgrade node\` will break it: run \`pmx mcp --install\`` };
  return { ok: true, detail: "the Claude app can start PMX's server" };
}

export async function mcpInstalled(): Promise<boolean> {
  const raw = await readFile(desktopConfig(), "utf8").catch(() => null);
  try { return !!raw && !!JSON.parse(raw)?.mcpServers?.pmx; } catch { return false; }
}

/**
 * Registers `pmx mcp` as the "pmx" server in the Claude desktop app, keeping every other setting. A file PMX
 * can't parse is never rewritten.
 */
export async function installMcp(node: string, cli: string): Promise<{ changed: boolean; error?: string }> {
  const file = desktopConfig();
  const raw = await readFile(file, "utf8").catch(() => null);
  let cfg: any = {};
  if (raw !== null) {
    try { cfg = JSON.parse(raw); } catch { return { changed: false, error: `${file} isn't valid JSON, so PMX left it alone. Fix it, then run \`pmx mcp --install\` again.` }; }
  }
  const want = { command: node, args: [cli, "mcp"] };
  if (JSON.stringify(cfg.mcpServers?.pmx) === JSON.stringify(want)) return { changed: false };
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), pmx: want };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.pmx-tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.pmx-tmp`, file);
  return { changed: true };
}
