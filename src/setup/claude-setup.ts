// SETUP-1: the Claude app's part of setting PMX up, in one chat. PMX can't create the app's scheduled tasks or publish
// its pages, so Claude does, and until now that took three commands in three chats (/pmx-schedule, /pmx-flow,
// /pmx-board). `pmx setup --prompt` prints all three as one set of instructions, in order, with the parts this Mac
// already has left out, and ends with exactly what's left for the person. /pmx-setup follows it.
//
// One source: each part's steps are read from that command's own skill file in this package (app-skills/<name>/SKILL.md),
// the same text /pmx-schedule, /pmx-flow and /pmx-board follow, so nothing is written twice and the three keep working.
import { readdir, readFile } from "node:fs/promises";
import { APP_SKILL, appSkillSource, BOARD_SKILL, FLOW_SKILL, type AppSkill } from "../claude/skill.js";
import { serversDir } from "../mcp/handoff.js";
import type { Checklist, Step } from "./checklist.js";

export type PartId = "tasks" | "page" | "board";
/**
 * "do": this chat does it. "done": this Mac has it. "skip": it doesn't apply here. "wait": it can't be told yet, because
 * PMX has put nothing in the Claude app on this Mac: `pmx init`'s one question comes first.
 */
export type PartState = "do" | "done" | "skip" | "wait";

export interface SetupPart {
  id: PartId;
  title: string;
  state: PartState;
  /** Why, in the checklist's own words. */
  why: string;
  /** The command whose steps this part follows, which still does this one part by itself. */
  skill: AppSkill;
}

/** The parts in the order one chat does them: the tasks PMX can't work without, then its page, then the team's board. */
const PARTS: { id: PartId; step: string; title: string; skill: AppSkill }[] = [
  { id: "tasks", step: "claude.tasks", title: "PMX's scheduled tasks", skill: APP_SKILL },
  { id: "page", step: "claude.page", title: "PMX's page in Claude", skill: FLOW_SKILL },
  { id: "board", step: "claude.board", title: "your team's board", skill: BOARD_SKILL },
];

const stepOf = (cl: Checklist, id: string): Step | undefined => cl.sections.flatMap((s) => s.steps).find((s) => s.id === id);

/**
 * Which parts are left, from the checklist (never from memory): a step that's done or doesn't apply is skipped. The
 * tasks' own "warn" means they exist and a run waits for the person's Always allow, which is the person's step, not Claude's.
 */
export function setupParts(cl: Checklist): SetupPart[] {
  // No step for any part: the checklist couldn't look in the Claude app's folder, because PMX has added nothing there.
  // That is never "this Mac doesn't need it".
  const unknown = PARTS.every(({ step }) => !stepOf(cl, step));
  return PARTS.map(({ id, step, title, skill }) => {
    const s = stepOf(cl, step);
    if (!s) return { id, title, skill, state: unknown ? "wait" as const : "skip" as const, why: unknown ? "PMX has added nothing to the Claude app on this Mac yet" : "doesn't apply on this Mac" };
    const state: PartState = s.status === "skip" ? "skip" : s.status === "done" || (id === "tasks" && s.status === "warn") ? "done" : "do";
    return { id, title, skill, state, why: s.detail };
  });
}

/**
 * What `pmx init` makes with the PM's one yes and this Mac still lacks, or null when init has nothing left to ask.
 * `must`: something only that yes gives is missing (the background job, or PMX's place in the Claude app at all), so
 * the person has to run `pmx init`; the allow rules and PMX's server alone can also be added in the chat, each with its own question.
 */
export function initYesLeft(cl: Checklist, facts: AppFacts): { lacks: string[]; must: boolean } | null {
  const open = (id: string) => { const s = stepOf(cl, id); return !!s && (s.status === "todo" || s.status === "warn"); };
  const noJob = stepOf(cl, "job.installed")?.status === "todo";
  const nothingInClaude = setupParts(cl).some((p) => p.state === "wait");
  const lacks = [
    ...(noJob ? ["the background job"] : []),
    ...(nothingInClaude ? ["PMX's commands and always-allow rules in the Claude app"] : open("claude.allow") ? ["the always-allow rules"] : []),
    ...(facts.desktopApp && !facts.mcpRegistered ? ["PMX's server in the Claude app's settings"] : []),
  ];
  return lacks.length ? { lacks, must: noJob || nothingInClaude } : null;
}

const and = (list: string[]) => (list.length < 3 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/** A command's own steps, as its skill file has them: without the front matter, the "installed by" note and the title. */
export async function skillSteps(name: AppSkill): Promise<string> {
  const text = await readFile(appSkillSource(name), "utf8");
  return text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "").replace(/^\s*# .*\n+/, "").trim();
}

/**
 * Whether the Claude app runs PMX's server now. Each server leaves a note while it runs (src/mcp/handoff.ts), so an
 * entry in the app's settings with no server running is one the app hasn't started yet: it needs a restart.
 */
export async function serverRunning(): Promise<boolean> {
  for (const f of await readdir(serversDir()).catch(() => [] as string[])) {
    const pid = Number(f.replace(/\.json$/, ""));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); return true; } catch (e: any) { if (e?.code === "EPERM") return true; }
  }
  return false;
}

export interface AppFacts {
  /** The Claude desktop app is on this Mac (its settings folder exists). */
  desktopApp: boolean;
  /** The app's settings have an entry for PMX's server. */
  mcpRegistered: boolean;
  /** A PMX server the app started is running. */
  serverRunning: boolean;
}

/** Whether the app must be quit and opened again: "yes", "no", or "if-added" when the entry isn't there yet. */
export function restartNeeded(f: AppFacts): "yes" | "no" | "if-added" {
  if (!f.desktopApp) return "no";
  if (!f.mcpRegistered) return "if-added";
  return f.serverRunning ? "no" : "yes";
}

const RESTART = "Quit the Claude app completely (⌘Q, not just its window) and open it again, once: PMX's server is new in the app's settings, and the app starts it only when it opens. Until then PMX's page can't reach this Mac.";
const ASK_SERVER = "May I add PMX's server to the Claude desktop app's settings, so PMX's page works on this Mac? Any Claude chat on this Mac can then read PMX's counts, never meeting or task titles, and add to your do-not-read list.";
const STATE: Record<PartState, string> = { do: "to do", done: "done", skip: "not needed", wait: "waits for pmx init" };
/** The plain instruction when setup's one question never got its yes (no terminal to ask in, or the person said no). */
const INIT_FIRST = (lacks: string[]) => `Run \`pmx init\` in Terminal and answer its one question. Setup's one question hasn't had a yes on this Mac, so PMX still lacks ${and(lacks)}; one yes there makes ${lacks.length === 1 ? "it" : "them all"}, and nothing runs by itself until then. Only the user can give that yes: don't run \`pmx init\` for them.`;

/**
 * What /pmx-setup follows (`pmx setup --prompt`): every part in order with its command's own steps, the finished ones
 * named and left out, and a last part that says what's left for the person, the restart last and at most once.
 */
export async function setupPrompt(cl: Checklist, facts: AppFacts, steps: (name: AppSkill) => Promise<string> = skillSteps): Promise<string> {
  if (stepOf(cl, "setup.config")?.status !== "done")
    return [
      `PMX setup in the Claude app, for pmx ${cl.version}.`,
      "",
      "PMX isn't set up on this Mac yet, so there's nothing to do in the Claude app. Tell the user to run `pmx init` in Terminal themselves: it asks the few questions only they can answer, shows everything it will do, and changes nothing until they say yes. Don't run it for them and never type a token or password. When it's done they quit and reopen the Claude app and type /pmx-setup again.",
    ].join("\n");
  const parts = setupParts(cl);
  const restart = restartNeeded(facts);
  const tasks = parts.find((p) => p.id === "tasks")!;
  const tasksStep = stepOf(cl, "claude.tasks");
  const lines = [
    `PMX setup in the Claude app, for pmx ${cl.version}: one chat does every part below, in this order. These are PMX's own instructions for this version; where you remember a step differently, these win.`,
    "",
    `Where this Mac stands: ${cl.where}`,
    "",
    "Rules for this chat:",
    "- A person must be at the keyboard. If a scheduled task started this session, stop and do nothing else.",
    "- Do the parts in order. A part marked done or not needed is finished on this Mac: don't do it again.",
    "- Each part ends with things to tell the user. Keep them, and say them once at the end, briefly, with the links.",
    "- Never ask the user to quit or restart the Claude app before the last part. Quitting ends this chat, and they should have to do it once at most.",
    "- If this session can't use a part's tool (scheduled tasks, artifacts), say so in one line and go on. In the last part, name that part's own command for a new Code-tab session.",
    // LINEAR-2 (0.41.0): a key is pasted by the person, into PMX's own prompt in Terminal, and nowhere else.
    ...(stepOf(cl, "linear.connected") && stepOf(cl, "linear.connected")!.status !== "skip" ? ["- Never ask for, read, type or repeat a Linear API key in this chat. The user pastes theirs in Terminal, into PMX's own prompt (`pmx linear key`), and it's kept in the Mac's keychain only."] : []),
  ];
  for (const [n, p] of parts.entries()) {
    lines.push("", `## Part ${n + 1} of ${parts.length}: ${p.title} (${STATE[p.state]}: ${p.why})`);
    if (p.state === "wait") { lines.push("Not in this chat: the user runs `pmx init` first (the last part says how), then types /pmx-setup again."); continue; }
    if (p.state !== "do") { lines.push(p.state === "done" ? "Nothing to do here." : "This Mac doesn't need it."); continue; }
    lines.push(`These are the steps /${p.skill} follows; that command still does this part by itself.`);
    if (p.id === "page" && facts.desktopApp && !facts.mcpRegistered)
      lines.push("", `Before step 1: PMX's server isn't in the Claude app's settings yet, and the page needs it. Ask the user: "${ASK_SERVER}" On yes, run \`pmx mcp --install --yes\`. On no, go on: the page then shows how to connect. This replaces what the steps below say about \`pmx mcp --install\`, and the restart waits for the last part.`);
    lines.push("", await steps(p.skill));
  }
  const left: string[] = [];
  const init = initYesLeft(cl, facts);
  // First on the list: without that yes nothing else on it helps.
  if (init?.must) left.push(`${INIT_FIRST(init.lacks)}${parts.some((p) => p.state === "wait") ? " Afterwards they quit the Claude app completely (⌘Q), open it again and type /pmx-setup: this chat then does the parts above." : ""}`);
  if (tasks.state === "do") left.push("For each scheduled task you created or updated: in the Claude app, Code tab → Scheduled → the task → Run now, once, and choose Always allow for what it asks (its connector). Until they do, that task's later runs wait for an approval nobody sees.");
  else if (tasksStep?.status === "warn") left.push(`${tasksStep.detail}. In the Claude app: Code tab → Scheduled → the task → its last run → Always allow (or Run now, if it never ran).`);
  for (const p of parts) if (p.state === "do") left.push(`Only if you couldn't do "${p.title}" in this session: type /${p.skill} in a new Code-tab session in the Claude app${p.id === "tasks" ? ", with auto mode off" : ""}.`);
  // LINEAR-2 (0.41.0): what Linear still needs from the person, where the checklist says so: a key Linear no longer
  // accepts (nothing reaches Linear until it's replaced), or, once and as theirs to leave, that a key is PMX's usual way.
  const linearStep = stepOf(cl, "linear.connected"), keyStep = stepOf(cl, "linear.key");
  if (linearStep && linearStep.status !== "done" && /API key/.test(linearStep.detail)) left.push(`${linearStep.detail} Only the user can: in Terminal, \`pmx linear key\`, pasted into PMX's own prompt, never into this chat.`);
  else if (keyStep?.status === "todo") left.push("Optional, and only the user can: PMX's usual way to Linear is their own Linear API key, with which it syncs every half hour instead of once an hour through this app. They run `pmx linear key` in Terminal (it says where to create the key and what to choose) and paste it into PMX's own prompt, never into this chat. If they'd rather not, the Linear sync task carries it, and pressing Return at that prompt stops PMX suggesting it.");
  // The restart is always the last thing on the list: quitting the app ends the chat it's said in.
  if (restart === "yes") left.push(`${RESTART} Say this one last.`);
  // Where the parts wait for `pmx init`, the restart is already part of that item.
  if (restart === "if-added" && !parts.some((p) => p.state === "wait")) left.push(`Only if ${init?.must ? "PMX's server was added, by `pmx init` or in this chat" : "you added PMX's server in this chat"}: ${RESTART.charAt(0).toLowerCase()}${RESTART.slice(1)} Say this one last. If the user said no to the server, leave this out.`);
  lines.push(
    "",
    "## Last: what's left for the person",
    "Run `pmx checklist --json` once more, so you say what this Mac shows and not what you remember. Then tell the user what is theirs to do now, as a short numbered list in this order, and nothing they needn't do:",
    ...(left.length ? left.map((l, n) => `${n + 1}. ${l}`) : ["(Nothing: every part is done and the Claude app already runs PMX's server.)"]),
    ...(restart === "no" && facts.desktopApp ? ["No restart is needed: the Claude app already runs PMX's server. Don't ask for one."] : []),
    "After the list: the links you published, the parts' notes you kept, where they stand in two sentences (the checklist's `where`), and that /pmx-setup shows it again any time. If the checklist still has an open required step that isn't on this list, go on with it as the guide's \"Working through the checklist\" says.",
  );
  return lines.join("\n");
}

/** The same for a person in Terminal (`pmx setup`): what's left in the Claude app, and that one chat does it. */
export function formatSetup(cl: Checklist, facts: AppFacts): string {
  if (stepOf(cl, "setup.config")?.status !== "done") return "PMX isn't set up on this Mac yet. Run `pmx init`: it asks a few questions, shows what it will do, and changes nothing until you say yes.";
  const parts = setupParts(cl);
  const mark: Record<PartState, string> = { do: "✘", done: "✔", skip: "–", wait: "✘" };
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const todo = parts.filter((p) => p.state === "do");
  const init = initYesLeft(cl, facts);
  // Setup's one question never got its yes: that comes before anything in the Claude app.
  if (init?.must) return [
    "PMX's setup in the Claude app:",
    ...parts.map((p) => `  ${mark[p.state]} ${cap(p.title)}: ${p.why}`),
    "",
    `First: run pmx init and answer its one question. It hasn't had a yes on this Mac, so PMX still lacks ${and(init.lacks)}; one yes makes ${init.lacks.length === 1 ? "it" : "them all"}.`,
    "Then quit the Claude app (⌘Q), open it again, and type /pmx-setup in its Code tab: one chat does the rest.",
  ].join("\n");
  const tasksWarn = stepOf(cl, "claude.tasks")?.status === "warn";
  const restart = restartNeeded(facts);
  const yours = [
    ...(todo.some((p) => p.id === "tasks") || tasksWarn ? ["click Run now on each PMX task once (Code tab → Scheduled) and choose Always allow"] : []),
    ...(restart === "yes" && !todo.length ? ["quit the Claude app (⌘Q) and open it again, once, so it starts PMX's server"] : []),
  ];
  return [
    "PMX's setup in the Claude app:",
    ...parts.map((p) => `  ${mark[p.state]} ${cap(p.title)}: ${p.why}`),
    "",
    todo.length ? `In the Claude app's Code tab, type /pmx-setup: one chat does ${todo.length === 1 ? "it" : `all ${todo.length}`}.${restart === "yes" ? " Quit the app (⌘Q) and open it again first, so it has PMX's commands and starts PMX's server." : ""}` : "Nothing is left for Claude to do there.",
    ...(yours.length ? [`Yours${todo.length ? " afterwards" : ""}: ${yours.join("; ")}.`] : []),
  ].join("\n");
}
