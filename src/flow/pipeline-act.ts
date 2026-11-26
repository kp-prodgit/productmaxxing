import type { PipelineData } from "./pipeline.js";

/**
 * What the board can do, behind one door (BOARD-3, BOARD-6): `pmx flow --web` serves it as POST /api/pipeline/<path>,
 * and `pmx mcp` as the `board_act` tool for a paired page (FLOW-4). Both check the same shapes here.
 */
export interface PipelineActions {
  data(hours: number): Promise<PipelineData>;
  /** "start" is Start now (APPROVE-3): approve and make Ready. "approve" sends to the pool. */
  /** R6: `reason`, for a drop only: why the PM dropped it, kept with the drop on this Mac. */
  proposals(action: "approve" | "start" | "drop", ids: string[], reason?: string): Promise<string>;
  /** EQ-38: set or clear one proposal's roadmap theme. This Mac's page only, like the proposals themselves. */
  proposalTheme?(id: string, theme: string | null): Promise<{ status: number; body: unknown }>;
  changes(changes: unknown[], confirmLoosening: boolean): Promise<{ status: number; body: unknown }>;
  whatIf(kind: string, value: string): Promise<unknown>;
  review(identifier: string, verdict: string, note: string): Promise<{ status: number; body: unknown }>;
  digest?(action: string, week: string, markdown?: string): Promise<{ status: number; body: unknown }>;
  run?(step: string): Promise<{ status: number; body: unknown }>;
  todoDone?(id: string): Promise<{ status: number; body: unknown }>;
  todoAdd?(input: { text: unknown; due?: unknown; when?: unknown }): Promise<{ status: number; body: unknown }>;
  todoPlace?(id: string, p: { due?: unknown; when?: unknown; reopen?: boolean }): Promise<{ status: number; body: unknown }>;
  /** SIG-7: send one to-do to Linear, when the PM turned that on. */
  todoLinear?(id: string): Promise<{ status: number; body: unknown }>;
  /** TODO-5: move work between a private to-do, a to-do in Linear and a product task, in any direction. */
  move?(input: { ref: string; to: string; kind?: string; size?: string }): Promise<{ status: number; body: unknown }>;
  setup?(action: string): Promise<{ status: number; body: unknown }>;
  /** BOARD-8: the Claude app's page opens this Mac's own page ("open", starting it if needed) or stops it ("stop"). */
  localPage?(action: string): Promise<{ status: number; body: unknown }>;
  /** BOARD-9: applies team settings that stayed a local branch because the team repo has no remote. */
  teamApply?(branch: string): Promise<{ status: number; body: unknown }>;
  resume?(category: string): Promise<{ status: number; body: unknown }>;
  /** PULL-12: Try again or Drop a task PMX stopped after failed runs. */
  stopped?(identifier: string, action: string): Promise<{ status: number; body: unknown }>;
  /** SETUP-2: one setup step PMX can do itself, from its allowlist; answers with the checklist worked out again. */
  checklistFix?(step: string): Promise<{ status: number; body: unknown }>;
  /** CLAUDE-6: when PMX's Claude tasks do their work, "weekdays" or "always". */
  taskHours?(hours: string): Promise<{ status: number; body: unknown }>;
  /** FLOW-8: the page `/pmx-flow` would publish now, so the page in Claude can publish it over itself. */
  pageHtml?(): Promise<{ status: number; body: unknown }>;
  /** FLOW-8: the page in Claude published that newer page over itself. */
  pagePublished?(version: string): Promise<{ status: number; body: unknown }>;
  /** OBS-5: what PMX is doing on this Mac right now. Read only while Health → Running is open. */
  running?(): Promise<{ status: number; body: unknown }>;
  /** BOARD-11: PMX Engine's studio opened at one of its places, in this Mac's browser. */
  engineOpen?(place: string): Promise<{ status: number; body: unknown }>;
}

export const ACT_PATHS = ["proposals", "proposal-theme", "changes", "review", "digest", "run", "todo", "todo-add", "todo-place", "todo-linear", "move", "resume", "setup", "local-page", "team-apply", "stopped", "what-if", "checklist-fix", "task-hours", "page-html", "page-published", "running", "engine-open"] as const;

/** One action: its path without /api/pipeline/, and its JSON body. Returns an HTTP-style status and body. */
export async function pipelineAct(o: PipelineActions, path: string, body: any): Promise<[number, unknown]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [400, { error: "the body must be a JSON object" }];
  if (path === "what-if") return [200, { whatIf: await o.whatIf(String(body.kind ?? ""), String(body.value ?? "")) }];
  if (path === "proposals") {
    if (body.action !== "approve" && body.action !== "start" && body.action !== "drop") return [400, { error: "action must be start, approve or drop" }];
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some((x: unknown) => typeof x !== "string")) return [400, { error: "ids must be the IDs of tasks waiting for approval" }];
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.action !== "drop")) return [400, { error: "reason is a few words, for a drop" }];
    return [200, { message: await o.proposals(body.action, body.ids, body.action === "drop" && typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined) }];
  }
  if (path === "proposal-theme" && o.proposalTheme) {
    if (typeof body.id !== "string" || (body.theme !== null && typeof body.theme !== "string")) return [400, { error: "id is the ID of a task waiting for approval, and theme a theme name or null" }];
    const r = await o.proposalTheme(body.id, body.theme === null ? null : body.theme.slice(0, 100));
    return [r.status, r.body];
  }
  if (path === "changes") {
    if (!Array.isArray(body.changes) || body.changes.length > 100) return [400, { error: "changes must be a list" }];
    const r = await o.changes(body.changes, body.confirmLoosening === true);
    return [r.status, r.body];
  }
  if (path === "review") {
    if (typeof body.identifier !== "string" || typeof body.verdict !== "string") return [400, { error: "identifier and verdict are required" }];
    const r = await o.review(body.identifier, body.verdict, typeof body.note === "string" ? body.note.slice(0, 2000) : "");
    return [r.status, r.body];
  }
  if (path === "digest" && o.digest) {
    if (typeof body.action !== "string" || typeof body.week !== "string") return [400, { error: "action and week are required" }];
    const r = await o.digest(body.action, body.week, typeof body.markdown === "string" ? body.markdown : undefined);
    return [r.status, r.body];
  }
  if (path === "run" && o.run) {
    if (typeof body.step !== "string") return [400, { error: "step is required" }];
    const r = await o.run(body.step);
    return [r.status, r.body];
  }
  if (path === "todo" && o.todoDone) { const r = await o.todoDone(String(body.id ?? "")); return [r.status, r.body]; }
  if (path === "todo-add" && o.todoAdd) { const r = await o.todoAdd({ text: body.text, due: body.due, when: body.when }); return [r.status, r.body]; }
  if (path === "todo-place" && o.todoPlace) { const r = await o.todoPlace(String(body.id ?? ""), { due: body.due, when: body.when, reopen: body.reopen === true }); return [r.status, r.body]; }
  if (path === "todo-linear" && o.todoLinear) { const r = await o.todoLinear(String(body.id ?? "")); return [r.status, r.body]; }
  if (path === "move" && o.move) {
    if (typeof body.ref !== "string" || typeof body.to !== "string") return [400, { error: "ref and to are required" }];
    const opt = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : undefined);
    const r = await o.move({ ref: body.ref.slice(0, 64), to: body.to, kind: opt(body.kind), size: opt(body.size) });
    return [r.status, r.body];
  }
  if (path === "stopped" && o.stopped) {
    if (typeof body.identifier !== "string" || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(body.identifier) || (body.action !== "retry" && body.action !== "drop")) return [400, { error: "identifier is a task like PMX-12, and action retry or drop" }];
    const r = await o.stopped(body.identifier, body.action);
    return [r.status, r.body];
  }
  if (path === "checklist-fix" && o.checklistFix) {
    if (typeof body.step !== "string" || !/^[a-z][\w.-]{1,63}$/.test(body.step)) return [400, { error: "step is a checklist step ID" }];
    const r = await o.checklistFix(body.step);
    return [r.status, r.body];
  }
  if (path === "task-hours" && o.taskHours) { const r = await o.taskHours(String(body.hours ?? "")); return [r.status, r.body]; }
  if (path === "page-html" && o.pageHtml) { const r = await o.pageHtml(); return [r.status, r.body]; }
  if (path === "page-published" && o.pagePublished) { const r = await o.pagePublished(String(body.version ?? "")); return [r.status, r.body]; }
  if (path === "running" && o.running) { const r = await o.running(); return [r.status, r.body]; }
  if (path === "engine-open" && o.engineOpen) {
    if (typeof body.place !== "string" || body.place.length > 40) return [400, { error: "place is a place in PMX Engine's studio" }];
    const r = await o.engineOpen(body.place);
    return [r.status, r.body];
  }
  if (path === "resume" && o.resume) { const r = await o.resume(String(body.category ?? "")); return [r.status, r.body]; }
  if (path === "setup" && o.setup) { const r = await o.setup(String(body.action ?? "")); return [r.status, r.body]; }
  if (path === "local-page" && o.localPage) { const r = await o.localPage(String(body.action ?? "")); return [r.status, r.body]; }
  if (path === "team-apply" && o.teamApply) { const r = await o.teamApply(String(body.branch ?? "")); return [r.status, r.body]; }
  return [404, { error: "not found" }];
}
