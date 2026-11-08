import { privacyRules } from "../digest/gather.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import { HOLD_LABELS, TOPIC_RULES } from "../core/filter.js";
import { paths } from "../core/paths.js";
import { listReceipts, readReceipt } from "../core/receipt.js";
import { parseRubric } from "../core/skillcheck.js";
import { loadSkill, skillInventory, SKILL_USES } from "../core/skills.js";
import { FLAG_TEXT } from "../synth/synthesize.js";
import { page } from "./page.js";
import { flowPage } from "../flow/page.js";
import { localPipelinePage } from "../flow/pipeline-page.js";
import type { PipelineData } from "../flow/pipeline.js";
import { currentVersion } from "../core/version.js";
import type { FlowGraph } from "../flow/graph.js";
import { resolveLive } from "./resolve.js";

export interface ExplainServer {
  url: string;
  flowUrl: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

/**
 * `pmx explain --web`: a read-only page on 127.0.0.1 (PRIV-4). The page itself holds no data; it reads
 * the access token from the URL fragment, drops it from the address bar and history, and sends it as a
 * header on every API call. The API answers only GET with that token and a loopback Host. Scripts and
 * styles need a per-response nonce, so nothing injected into a receipt can run.
 */
export async function startExplainServer(o: {
  team: TeamConfig; personal: PersonalConfig; port?: number;
  /** The flow view's graph (FLOW-2): "mine" is this Mac at the local level, "team" the shared run log. */
  flow?: (hours: number, scope: "mine" | "team") => Promise<FlowGraph>;
  /**
   * The pipeline board (BOARD-3), served at /flow. Its writes are POSTs with the same token: approving or dropping
   * proposals, and settings changes, which only this Mac's page may send.
   */
  pipeline?: {
    data(hours: number): Promise<PipelineData>;
    proposals(action: "approve" | "drop", ids: string[]): Promise<string>;
    changes(changes: unknown[], confirmLoosening: boolean): Promise<{ status: number; body: unknown }>;
    whatIf(kind: string, value: string): Promise<unknown>;
    review(identifier: string, verdict: string, note: string): Promise<{ status: number; body: unknown }>;
    digest?(action: string, week: string, markdown?: string): Promise<{ status: number; body: unknown }>;
    run?(step: string): Promise<{ status: number; body: unknown }>;
    todoDone?(id: string): Promise<{ status: number; body: unknown }>;
    setup?(action: string): Promise<{ status: number; body: unknown }>;
    resume?(category: string): Promise<{ status: number; body: unknown }>;
  };
}): Promise<ExplainServer> {
  const token = randomBytes(24).toString("base64url");
  const want = Buffer.from(`Bearer ${token}`);
  let port = 0;

  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin", ...extra,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json; charset=utf-8", JSON.stringify(body));

  const api = async (path: string, query: URLSearchParams, body: any): Promise<[number, unknown]> => {
    if (o.pipeline && path === "/api/pipeline") {
      const hours = Number(query.get("hours") ?? 168);
      if (!Number.isInteger(hours) || hours < 1 || hours > 336) return [400, { error: "hours must be 1 to 336" }];
      return [200, { pipeline: await o.pipeline.data(hours) }];
    }
    if (o.pipeline && path === "/api/pipeline/what-if") return [200, { whatIf: await o.pipeline.whatIf(query.get("kind") ?? "", query.get("value") ?? "") }];
    if (o.pipeline && path === "/api/pipeline/proposals" && body) {
      if (body.action !== "approve" && body.action !== "drop") return [400, { error: "action must be approve or drop" }];
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some((x: unknown) => typeof x !== "string")) return [400, { error: "ids must be proposal IDs" }];
      return [200, { message: await o.pipeline.proposals(body.action, body.ids) }];
    }
    if (o.pipeline && path === "/api/pipeline/changes" && body) {
      if (!Array.isArray(body.changes) || body.changes.length > 100) return [400, { error: "changes must be a list" }];
      const r = await o.pipeline.changes(body.changes, body.confirmLoosening === true);
      return [r.status, r.body];
    }
    if (o.pipeline && path === "/api/pipeline/review" && body) {
      if (typeof body.identifier !== "string" || typeof body.verdict !== "string") return [400, { error: "identifier and verdict are required" }];
      const r = await o.pipeline.review(body.identifier, body.verdict, typeof body.note === "string" ? body.note.slice(0, 2000) : "");
      return [r.status, r.body];
    }
    if (o.pipeline?.digest && path === "/api/pipeline/digest" && body) {
      if (typeof body.action !== "string" || typeof body.week !== "string") return [400, { error: "action and week are required" }];
      const r = await o.pipeline.digest(body.action, body.week, typeof body.markdown === "string" ? body.markdown : undefined);
      return [r.status, r.body];
    }
    if (o.pipeline?.run && path === "/api/pipeline/run" && body) {
      if (typeof body.step !== "string") return [400, { error: "step is required" }];
      const r = await o.pipeline.run(body.step);
      return [r.status, r.body];
    }
    if (o.pipeline?.todoDone && path === "/api/pipeline/todo" && body) {
      const r = await o.pipeline.todoDone(String(body.id ?? ""));
      return [r.status, r.body];
    }
    if (o.pipeline?.resume && path === "/api/pipeline/resume" && body) {
      const r = await o.pipeline.resume(String(body.category ?? ""));
      return [r.status, r.body];
    }
    if (o.pipeline?.setup && path === "/api/pipeline/setup" && body) {
      const r = await o.pipeline.setup(String(body.action ?? ""));
      return [r.status, r.body];
    }
    if (path === "/api/flow") {
      if (!o.flow) return [404, { error: "not found" }];
      const hours = Number(query.get("hours") ?? 24);
      if (!Number.isInteger(hours) || hours < 1 || hours > 336) return [400, { error: "hours must be 1 to 336" }];
      return [200, { graph: await o.flow(hours, query.get("scope") === "team" ? "team" : "mine") }];
    }
    if (path === "/api/runs") {
      const ids = await listReceipts();
      const runs = [];
      for (const id of ids) {
        const r = await readReceipt(id);
        if (r) runs.push({ id, type: r.type, at: r.at, outcome: r.outcome, dryRun: !!r.dryRun });
      }
      return [200, { runs }];
    }
    const m = path.match(/^\/api\/runs\/([\w-]{1,64})$/);
    if (m) {
      const r = await readReceipt(m[1]!);
      if (!r) return [404, { error: "no such run" }];
      return [200, { receipt: r, live: await resolveLive(r, o.personal.sources.transcriptDirs) }];
    }
    if (path === "/api/rules") {
      return [200, {
        internalDomains: privacyRules(o).internalDomains,
        allowedSources: o.team.allowedSources,
        slackChannels: o.team.slackChannels,
        folders: o.personal.sources.transcriptDirs,
        // The PM's own do-not-read list, on their own screen. Receipts store only how many entries it has.
        neverIngest: o.personal.neverIngest,
        topics: TOPIC_RULES,
        holdLabels: HOLD_LABELS,
        profile: paths.claudeProfile(),
      }];
    }
    if (path === "/api/skills") return [200, { skills: await skillInventory(o.personal.repoPath, o.team.categories), profile: paths.claudeProfile() }];
    if (path === "/api/sizing") {
      const rubric = await loadSkill(o.personal.repoPath, SKILL_USES.synthesize[1]);
      const latest = (await listReceipts()).find((id) => id.startsWith("synthesize-"));
      const r = latest ? await readReceipt(latest) : null;
      return [200, { rubric: parseRubric(rubric.text), source: rubric.source, version: rubric.version, sizes: o.team.sizes, flagText: FLAG_TEXT, latest: r ? { id: r.id, at: r.at, tasks: r.synth?.tasks ?? [] } : null }];
    }
    return [404, { error: "not found" }];
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, "text/plain", "Forbidden");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      // Only the board's own writes are POSTs, as JSON with the token, so a page elsewhere can't send them.
      const post = req.method === "POST" && path.startsWith("/api/pipeline/") && (req.headers["content-type"] ?? "").startsWith("application/json");
      if (req.method !== "GET" && !post) return send(res, 405, "text/plain", "Method not allowed", { allow: "GET" });
      if (path === "/" || (path === "/flow" && (o.flow || o.pipeline))) {
        const nonce = randomBytes(16).toString("base64");
        const html = path === "/flow" ? (o.pipeline ? localPipelinePage(nonce, { version: currentVersion(), team: o.team.team }) : flowPage(nonce)) : page(nonce);
        return send(res, 200, "text/html; charset=utf-8", html, {
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (!path.startsWith("/api/")) return send(res, 404, "text/plain", "Not found");
      const given = Buffer.from(req.headers.authorization ?? "");
      if (given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 403, { error: `this page's link has expired: run ${o.pipeline ? "pmx flow --web" : o.flow ? "pmx flow --web" : "pmx explain --web"} again` });
      let body: unknown = null;
      if (post) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > 65536) return json(res, 413, { error: "too large" }); chunks.push(c as Buffer); }
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "not JSON" }); }
      }
      const [status, out] = await api(path, url.searchParams, body);
      return json(res, status, out);
    } catch (e: any) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/#t=${token}`,
    flowUrl: `http://127.0.0.1:${port}/flow#t=${token}`,
    port,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
