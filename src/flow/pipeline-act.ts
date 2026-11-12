import type { PipelineData } from "./pipeline.js";

/**
 * What the board can do, behind one door (BOARD-3, BOARD-6): `pmx flow --web` serves it as POST /api/pipeline/<path>,
 * and `pmx mcp` as the `board_act` tool for a paired page (FLOW-4). Both check the same shapes here.
 */
export interface PipelineActions {
  data(hours: number): Promise<PipelineData>;
  proposals(action: "approve" | "drop", ids: string[]): Promise<string>;
  changes(changes: unknown[], confirmLoosening: boolean): Promise<{ status: number; body: unknown }>;
  whatIf(kind: string, value: string): Promise<unknown>;
  review(identifier: string, verdict: string, note: string): Promise<{ status: number; body: unknown }>;
  digest?(action: string, week: string, markdown?: string): Promise<{ status: number; body: unknown }>;
  run?(step: string): Promise<{ status: number; body: unknown }>;
  todoDone?(id: string): Promise<{ status: number; body: unknown }>;
  todoAdd?(input: { text: unknown; due?: unknown; when?: unknown }): Promise<{ status: number; body: unknown }>;
  todoPlace?(id: string, p: { due?: unknown; when?: unknown; reopen?: boolean }): Promise<{ status: number; body: unknown }>;
  setup?(action: string): Promise<{ status: number; body: unknown }>;
  resume?(category: string): Promise<{ status: number; body: unknown }>;
}

export const ACT_PATHS = ["proposals", "changes", "review", "digest", "run", "todo", "todo-add", "todo-place", "resume", "setup", "what-if"] as const;

/** One action: its path without /api/pipeline/, and its JSON body. Returns an HTTP-style status and body. */
export async function pipelineAct(o: PipelineActions, path: string, body: any): Promise<[number, unknown]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [400, { error: "the body must be a JSON object" }];
  if (path === "what-if") return [200, { whatIf: await o.whatIf(String(body.kind ?? ""), String(body.value ?? "")) }];
  if (path === "proposals") {
    if (body.action !== "approve" && body.action !== "drop") return [400, { error: "action must be approve or drop" }];
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some((x: unknown) => typeof x !== "string")) return [400, { error: "ids must be proposal IDs" }];
    return [200, { message: await o.proposals(body.action, body.ids) }];
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
  if (path === "resume" && o.resume) { const r = await o.resume(String(body.category ?? "")); return [r.status, r.body]; }
  if (path === "setup" && o.setup) { const r = await o.setup(String(body.action ?? "")); return [r.status, r.body]; }
  return [404, { error: "not found" }];
}
