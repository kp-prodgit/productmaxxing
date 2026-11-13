// Drives the real /pmx-flow page in a simulated browser (jsdom), against PMX's real board server on a throwaway
// home and team repo. Clicks go through the page's own handlers, saves through the server's, and settings land on disk.
import { JSDOM } from "jsdom";
import type { Ctx } from "../src/core/context.js";
import type { PersonalConfig, TeamConfig } from "../src/core/config.js";
import { startExplainServer, type ExplainServer } from "../src/explain/server.js";
import { liveHandlers, pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { handleMcp } from "../src/mcp/server.js";
import { currentVersion } from "../src/core/version.js";
import { readFile } from "node:fs/promises";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

export interface Ui {
  ctx: Ctx;
  dom: JSDOM;
  win: any;
  doc: Document;
  /** Every POST the page sent: [path, body]. */
  posts: [string, any][];
  $(sel: string): HTMLElement | null;
  all(sel: string): HTMLElement[];
  text(sel?: string): string;
  /** The button (or link-like button) whose text is exactly `label`, inside `within`. */
  button(label: string | RegExp, within?: string): HTMLButtonElement;
  switchFor(label: string): HTMLElement;
  click(el: Element): Promise<void>;
  pick(sel: HTMLSelectElement | string, value: string): Promise<void>;
  type(input: HTMLInputElement | string, value: string): Promise<void>;
  go(hash: string): Promise<void>;
  bar(): string;
  until<T>(fn: () => T, what: string, ms?: number): Promise<T>;
  /** Reloads the page from the server, as the PM pressing ⌘R would. */
  reload(hash?: string): Promise<void>;
  close(): Promise<void>;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * `app: true` opens the page as the Claude app shows it (/pmx-flow): it reaches PMX through `window.claude` and PMX's
 * real MCP handler, which builds a fresh context from disk for every call, as the server the Claude app starts does.
 * The page is connected first, as a PM clicking Connect and allowing it on the Mac would.
 */
export async function openBoard(o: { team?: Partial<TeamConfig>; personal?: Partial<PersonalConfig>; hash?: string; now?: Date; app?: boolean; staleServer?: boolean; before?: (ctx: Ctx) => Promise<void> } = {}): Promise<Ui> {
  await freshHome();
  const { repo } = await pmxRepo(o.team ?? {});
  const ctx = await testCtx({ repo, team: o.team, personal: o.personal, now: o.now ?? new Date() });
  const { savePersonalConfig } = await import("../src/core/config.js");
  await savePersonalConfig(ctx.personal);
  if (o.before) await o.before(ctx);
  const { loadPersonalConfig } = await import("../src/core/config.js");
  // Like realCtx(): the PM's settings as they are on disk now, for every call.
  const freshCtx = async () => testCtx({ repo, team: o.team, personal: await loadPersonalConfig(), now: o.now ?? new Date() });
  // Wired as `pmx flow --web` wires it; `staleServer` is the pre-0.25.1 wiring, kept to prove the regression test.
  const server: ExplainServer = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: o.staleServer ? pipelineHandlers(ctx) : await liveHandlers(freshCtx) });
  const base = new URL(server.flowUrl);
  const posts: [string, any][] = [];
  let dom!: JSDOM;

  let rpc = 0;
  const appPage = async () => (await readFile(pipelineTemplate(), "utf8"))
    .replace('{"mode":"artifact","version":"0.0.0"}', JSON.stringify({ mode: "artifact", version: currentVersion(), team: ctx.team.team }));

  const loadApp = async (hash: string) => {
    if (dom) dom.window.close();
    dom = new JSDOM(`<!doctype html><html lang=en><head><meta charset=utf-8></head><body>${await appPage()}</body></html>`, {
      url: `http://artifact.test/#${hash.replace(/^#/, "")}`, runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(w: any) {
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        w.scrollTo = () => {};
        w.HTMLElement.prototype.scrollIntoView = function () {};
        w.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => `\\${c}`) };
        w.claude = {
          use: async (name: string) => name !== "mcp" ? null : {
            async callTool(_server: string, tool: string, args: any) {
              if (tool === "board_act") posts.push([args.path, args.body]);
              const out: any = await handleMcp({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: tool, arguments: args } }, freshCtx, { confirm: async () => true });
              if (out.error) throw Object.assign(new w.Error(out.error.message), { code: out.error.code === -32602 ? "unknown_tool" : "tool_error" });
              const r = out.result ?? {};
              const payload = r.structuredContent ?? (r.content?.[0] ? JSON.parse(r.content[0].text) : null);
              if (r.isError) throw Object.assign(new w.Error(JSON.stringify(payload)), { code: "tool_error", result: { structuredContent: payload } });
              return { payload };
            },
          },
        };
      },
    });
    await ui.until(() => dom.window.document.querySelector("main h1"), "the page to render");
    // A new page has no key yet (each simulated browser starts with empty storage), so it connects like a PM would.
    await ui.until(() => [...dom.window.document.querySelectorAll("main button")].find((b) => b.textContent?.trim() === "Connect"), "Connect");
    await ui.click(ui.button("Connect", "main"));
    await ui.until(() => /Connected/.test(dom.window.document.body.textContent ?? "") || dom.window.document.querySelector("#savebar, main [role=list]"), "the page to connect");
    if (hash) await ui.go(`#${hash.replace(/^#/, "")}`);
    await ui.until(() => !/Loading|Connect this page/.test(dom.window.document.querySelector("main")?.textContent ?? "") && dom.window.document.querySelector("main h1, main h2"), "the workspace to load");
  };

  const load = async (hash: string) => {
    if (o.app) return loadApp(hash);
    if (dom) dom.window.close();
    const url = `${base.origin}${base.pathname}${base.hash}&tab=${hash.replace(/^#/, "")}`;
    dom = await JSDOM.fromURL(url, {
      runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(w: any) {
        // The page's two doors to PMX: reads and POSTs to this Mac's server.
        w.fetch = async (path: string, init?: any) => {
          if (init?.method === "POST") posts.push([String(path).replace("/api/pipeline/", ""), JSON.parse(init.body)]);
          const r = await fetch(new URL(path, base.origin), init);
          const body = await r.text();
          return { ok: r.ok, status: r.status, json: async () => JSON.parse(body), text: async () => body };
        };
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        w.scrollTo = () => {};
        // jsdom has no CSS namespace; the page uses CSS.escape to find rows by key.
        w.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (c) => `\\${c}`) };
        w.HTMLElement.prototype.scrollIntoView = function () {};
      },
    });
    await ui.until(() => dom.window.document.querySelector("main h1"), "the page to render");
    await ui.until(() => !/Loading/.test(dom.window.document.querySelector("main")?.textContent ?? ""), "the workspace to load");
  };

  const ui: Ui = {
    ctx, posts,
    get dom() { return dom; },
    get win() { return dom.window; },
    get doc() { return dom.window.document; },
    $: (sel) => dom.window.document.querySelector(sel),
    all: (sel) => [...dom.window.document.querySelectorAll(sel)] as HTMLElement[],
    text: (sel = "main") => (dom.window.document.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " "),
    button(label, within = "body") {
      const m = (t: string) => (typeof label === "string" ? t === label : label.test(t));
      const b = ui.all(`${within} button`).find((x) => m((x.textContent ?? "").trim()) || m(x.getAttribute("aria-label") ?? ""));
      if (!b) throw new Error(`No button "${label}" in ${within}. Buttons: ${ui.all(`${within} button`).map((x) => (x.textContent ?? "").trim() || x.getAttribute("aria-label")).filter(Boolean).join(" · ")}`);
      return b as HTMLButtonElement;
    },
    switchFor(label) {
      const s = ui.all("[role=switch]").find((x) => x.getAttribute("aria-label") === label);
      if (!s) throw new Error(`No switch "${label}". Switches: ${ui.all("[role=switch]").map((x) => x.getAttribute("aria-label")).join(" · ")}`);
      return s;
    },
    async click(el) {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await tick(5);
    },
    async pick(sel, value) {
      const s = (typeof sel === "string" ? ui.$(sel) : sel) as HTMLSelectElement;
      if (!s) throw new Error(`No select ${sel}`);
      s.value = value;
      s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await tick(5);
    },
    async type(input, value) {
      const i = (typeof input === "string" ? ui.$(input) : input) as HTMLInputElement;
      if (!i) throw new Error(`No input ${input}`);
      i.focus();
      i.value = value;
      i.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await tick(5);
    },
    async go(hash) {
      dom.window.location.hash = hash;
      dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
      await tick(20);
    },
    bar: () => (ui.$("#savebar")?.textContent ?? "").replace(/\s+/g, " ").trim(),
    async until(fn, what, ms = 4000) {
      const end = Date.now() + ms;
      for (;;) {
        let v: any;
        try { v = fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Page: ${ui.text().slice(0, 400)}`);
        await tick(15);
      }
    },
    async reload(hash = "today") { await load(hash); },
    async close() { dom?.window.close(); await server.close(); },
  };
  await load(o.hash ?? "today");
  return ui;
}
