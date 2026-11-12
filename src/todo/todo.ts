import { allKeys } from "../meetings/ledger.js";
import { createHash } from "node:crypto";
import { checkBudget, recordSpend } from "../budget/provider.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { DATA_RULES, dataBlock } from "../core/prompt.js";
import { newReceiptId, writeReceipt, type RunReceipt } from "../core/receipt.js";
import { loadSkill, skillBody } from "../core/skills.js";
import { updateState } from "../core/state.js";
import { assertSchema } from "../core/version.js";
import { gather } from "../digest/gather.js";
import { localDay, startOfDay } from "../meetings/ledger.js";

export interface Todo {
  id: string;
  text: string;
  due: string | null;
  why: string;
  /** The meeting it came from: redacted title and date, plus the identity hashes. */
  source: { title: string; at: string; keys: string[] };
  status: "open" | "done";
  /**
   * Where the PM put it on the board (BOARD-6): Today, This Evening or Someday. Null is the default: Today once it's
   * due, Upcoming before that, Anytime with no date.
   */
  when?: "today" | "evening" | "someday" | null;
  createdAt: string;
  doneAt: string | null;
  /** The run that found it: `pmx explain <receiptId>`. */
  receiptId: string;
}

/** ~/.pmx/todos.json (0600): the PM's to-dos and which meetings were already read for them (TODO-3). */
interface Store {
  v: 1;
  /** Meeting key → when it was processed, so no meeting is read for to-dos twice. */
  processed: Record<string, string>;
  items: Todo[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const line = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function loadTodos(): Promise<Store> {
  const s = (await readJson<Store>(paths.todos())) ?? { v: 1, processed: {}, items: [] };
  // Never rewrite a to-do file a newer pmx wrote: an old CLI would drop what it doesn't know (COMPAT-3).
  assertSchema("todos", s.v, paths.todos());
  return s;
}

async function saveTodos(s: Store): Promise<void> {
  await privateDir(paths.home());
  // Keep 90 days of processed keys and done items.
  const cutoff = Date.now() - 90 * 86400000;
  for (const [k, at] of Object.entries(s.processed)) if (Date.parse(at) < cutoff) delete s.processed[k];
  s.items = s.items.filter((t) => t.status === "open" || !t.doneAt || Date.parse(t.doneAt) >= cutoff);
  await writeJson(paths.todos(), s, 0o600);
}

/** Loads, changes and saves the store under its lock, so a change made meanwhile by another process is never lost. */
async function mutateTodos<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  return withLock(paths.todos(), async () => {
    const s = await loadTodos();
    const out = await fn(s);
    await saveTodos(s);
    return out;
  });
}

export function parseTodos(text: string, validIds: Set<string>): { todos: { text: string; due: string | null; source: string; why: string }[]; dropped: string[] } {
  const m = text.match(/\{[\s\S]*\}/);
  let raw: any = null;
  try {
    raw = m ? JSON.parse(m[0]) : null;
  } catch {}
  const todos: { text: string; due: string | null; source: string; why: string }[] = [];
  const dropped: string[] = [];
  for (const t of Array.isArray(raw?.todos) ? raw.todos : []) {
    const body = line(t?.text, 120);
    if (!body) continue;
    if (!validIds.has(t?.source)) {
      dropped.push(`${body}: cites no meeting it was given`);
      continue;
    }
    todos.push({ text: body, due: /^\d{4}-\d{2}-\d{2}$/.test(t?.due ?? "") ? t.due : null, source: t.source, why: line(t?.why, 240) });
  }
  return { todos, dropped };
}

export interface TodoResult {
  added: Todo[];
  meetings: { read: number; alreadyRead: number; before: number };
  receiptId: string | null;
}

/**
 * `pmx todo --refresh` (TODO-1 to TODO-3): reads the PM's own meetings since `since` that haven't been
 * read for to-dos yet, including 1:1s and internal meetings (individual scope), and adds one cited
 * to-do per commitment. Nothing leaves the Mac except the model call on the PM's own Claude plan.
 */
export async function refreshTodos(ctx: Ctx, o: { since?: Date; dryRun?: boolean; skipIfNothingNew?: boolean } = {}): Promise<TodoResult> {
  const now = ctx.now();
  const since = o.since ?? startOfDay(now);
  const days = Math.ceil((now.getTime() - since.getTime()) / 86400000) + 1;
  const store = await loadTodos();
  const g = await gather(ctx, { days, scope: "individual" });
  const cutoff = localDay(since);
  const meetings = g.items.filter((i) => i.kind === "transcript");
  const before = meetings.filter((i) => i.at.slice(0, 10) < cutoff);
  const alreadyRead = meetings.filter((i) => i.at.slice(0, 10) >= cutoff && allKeys(i).some((k) => store.processed[k]));
  const work = meetings.filter((i) => i.at.slice(0, 10) >= cutoff && !allKeys(i).some((k) => store.processed[k]));
  const result: TodoResult = { added: [], meetings: { read: work.length, alreadyRead: alreadyRead.length, before: before.length }, receiptId: null };
  if (!work.length && o.skipIfNothingNew) return result;

  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("todo", now), type: "todo", at: now.toISOString(), agent: ctx.agent, dryRun: !!o.dryRun,
    outcome: "no-signal", ...g.receipt, skills: [], model: null,
  };
  const mark = (ids: string[], state: "already-processed" | "before-window" | "processed-now" | "would-process") => {
    for (const s of receipt.sources) if (s.id && ids.includes(s.id)) s.ledger = { state, entry: null };
  };
  mark(alreadyRead.map((i) => i.id), "already-processed");
  mark(before.map((i) => i.id), "before-window");
  mark(work.map((i) => i.id), o.dryRun ? "would-process" : "processed-now");
  result.receiptId = receipt.id;
  if (!work.length) {
    await writeReceipt(receipt, now);
    return result;
  }

  const skill = await loadSkill(ctx.personal.repoPath, "pmx-todo");
  receipt.skills = [{ name: "pmx-todo", version: skill.version, source: skill.source }];
  const me = ctx.personal.identity;
  const who = me && (me.names.length || me.emails.length)
    ? `The PM is ${[...me.names, ...me.emails].join(" / ")}.`
    : `The PM's handle is ${ctx.personal.handle}. Their name isn't known yet, so only include to-dos clearly addressed to the person taking notes.`;
  const { tag, block } = dataBlock(work);
  const prompt = [skillBody(skill.text), "", who, `Today is ${now.toISOString().slice(0, 10)}.`, DATA_RULES(tag), "", block].join("\n");
  await checkBudget(ctx);
  const r = await ctx.runtime.run({ team: ctx.team, cwd: ctx.personal.repoPath, prompt, tools: [], maxTurns: 1 });
  await updateState((s) => recordSpend(s, ctx.personal, now, r.costUsd, r.tokens));
  receipt.model = {
    name: ctx.team.model, runtime: ctx.runtime.name, tools: "none: no files, no web, no personal Claude settings",
    costUsd: r.costUsd, tokens: r.tokens, durationMs: r.durationMs, promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
  if (!r.ok) {
    await writeReceipt({ ...receipt, outcome: "failed", error: r.error ?? "unknown" }, now);
    throw new Error(`To-do run failed: ${r.error ?? "unknown"}`);
  }

  const parsed = parseTodos(r.text, new Set(work.map((i) => i.id)));
  const open = new Set(store.items.filter((t) => t.status === "open").map((t) => norm(t.text)));
  let duplicates = 0;
  const refs: NonNullable<RunReceipt["todo"]>["added"] = [];
  for (const t of parsed.todos) {
    if (open.has(norm(t.text))) { duplicates++; continue; }
    const src = work.find((i) => i.id === t.source)!;
    const todo: Todo = {
      id: createHash("sha256").update(`${receipt.id}\n${t.text}`).digest("hex").slice(0, 6),
      text: t.text, due: t.due, why: t.why, source: { title: src.title, at: src.at.slice(0, 10), keys: src.keys ?? [] },
      status: "open", createdAt: now.toISOString(), doneAt: null, receiptId: receipt.id,
    };
    result.added.push(todo);
    refs.push({ text: t.text, source: t.source, due: t.due });
    open.add(norm(t.text));
  }
  receipt.outcome = o.dryRun ? "dry-run" : "staged";
  receipt.todo = { added: refs, duplicates, dropped: parsed.dropped };
  await writeReceipt(receipt, now);
  if (!o.dryRun) {
    // Saved onto a fresh read: the PM may have ticked or added to-dos while Claude was reading.
    await mutateTodos((fresh) => {
      for (const i of work) for (const k of i.keys ?? []) fresh.processed[k] = now.toISOString();
      fresh.items.push(...result.added);
    });
  }
  return result;
}

const find = (s: Store, id: string) => {
  // An exact ID, or a unique prefix of one as typed in Terminal.
  const t = s.items.find((x) => x.id === id) ?? (id.length >= 3 ? s.items.filter((x) => x.id.startsWith(id)) : []).find((_, __, all) => all.length === 1);
  if (!t) throw new Error(`No to-do "${id}". See \`pmx todo\`.`);
  return t;
};

export async function completeTodo(id: string, now: Date): Promise<Todo> {
  return mutateTodos((s) => {
    const t = find(s, id);
    t.status = "done";
    t.doneAt = now.toISOString();
    return t;
  });
}

const WHEN = ["today", "evening", "someday"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Checks a placement from the board: a due date (YYYY-MM-DD) or none, and Today, This Evening, Someday or none. */
function checkPlacement(p: { due?: unknown; when?: unknown }): { due: string | null; when: Todo["when"] } {
  const due = p.due === undefined || p.due === null || p.due === "" ? null : String(p.due);
  if (due !== null && (!DAY.test(due) || Number.isNaN(Date.parse(due)))) throw new Error("A due date is a day like 2026-11-14.");
  const when = p.when === undefined || p.when === null || p.when === "" ? null : String(p.when);
  if (when !== null && !(WHEN as readonly string[]).includes(when)) throw new Error("A to-do goes in Today, This Evening or Someday.");
  return { due, when: when as Todo["when"] };
}

/** A to-do the PM typed on the board (BOARD-6). It comes from no meeting, so it carries no meeting keys. */
export async function addTodo(input: { text: unknown; due?: unknown; when?: unknown }, now: Date): Promise<Todo> {
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error("Give the to-do some words.");
  if (text.length > 200) throw new Error("Keep a to-do under 200 characters.");
  const { due, when } = checkPlacement(input);
  const todo: Todo = {
    id: createHash("sha256").update(`manual\n${now.toISOString()}\n${text}\n${Math.random()}`).digest("hex").slice(0, 6),
    text, due, why: "", when, source: { title: "Added by you", at: now.toISOString().slice(0, 10), keys: [] },
    status: "open", createdAt: now.toISOString(), doneAt: null, receiptId: "",
  };
  return mutateTodos((s) => { s.items.push(todo); return todo; });
}

/** Moves a to-do: a new due date and placement, or reopens one ticked by mistake. */
export async function placeTodo(id: string, p: { due?: unknown; when?: unknown; reopen?: boolean }): Promise<Todo> {
  const placed = checkPlacement(p);
  return mutateTodos((s) => {
    const t = find(s, id);
    t.due = placed.due;
    t.when = placed.when;
    if (p.reopen) { t.status = "open"; t.doneAt = null; }
    return t;
  });
}

export function formatTodos(items: Todo[]): string {
  if (!items.length) return "No open to-dos. `pmx todo --refresh` reads today's meetings.";
  const sorted = [...items].sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.createdAt.localeCompare(b.createdAt));
  return sorted
    .map((t) => `${t.status === "done" ? "✔" : "☐"} ${t.id}  ${t.text}${t.due ? `  (due ${t.due})` : ""}\n         from "${t.source.title}" on ${t.source.at}: ${t.why}`)
    .join("\n");
}
