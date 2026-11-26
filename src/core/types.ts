export const SIZES = ["S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

/** The product lifecycle a category's work belongs to, in order (CAT-2): identify → build → validate → productionize, plus operate. */
export const STAGES = ["identify", "build", "validate", "productionize", "operate"] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ["inbox", "ready", "claimed", "running", "review", "done", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

/** A PMX task as the engine sees it. Tracker-neutral (CANVAS-2). */
export interface Task {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  category: string | null;
  size: Size | null;
  status: Status | null;
  /** 1 urgent … 4 low, 0 none (Linear's scale). */
  priority: number;
  agent: string | null;
  sources: string[];
  prUrl: string | null;
  createdAt: string;
  /** The roadmap theme label (pmx-theme), when the PM approved the task with one (EQ-38). */
  theme?: string | null;
  /** Where the task is in the tracker's own workflow, when the tracker says (TASK-7, TASK-8). Absent: the label decides. */
  workflow?: Workflow | null;
}

/** A task's place in the tracker's own workflow (Linear's workflow state), next to PMX's own label (TASK-7, TASK-8). */
export interface Workflow {
  /** The state's type: triage, backlog, unstarted, started, completed or canceled. */
  type: string;
  /** The state's name, like Todo or In Review. Empty when PMX doesn't know it yet. */
  name: string;
  /**
   * The state type PMX last set on the task (its `pmx-state` label), or null when PMX hasn't recorded one: a state that
   * differs from it was moved by a person; a label that differs from it moved without the state (TASK-8).
   */
  recorded: string | null;
  /** What PMX's own `pmx-status` label says. Differs from the task's status only while PMX follows a person's move. */
  label: Status | null;
  /** Why PMX leaves the task alone after a person moved it in the tracker. No agent takes it. */
  held?: string;
  /** The label decides here: PMX moves the state to match it and records where it is (TASK-8). */
  align?: boolean;
}

/** A piece of signal after ingestion. `text` is untrusted data, never instructions (SEC-1). */
export interface SignalItem {
  /** Stable citation ID, e.g. `T3` or `S12`. */
  id: string;
  /** "thread": a conversation from an approved channel, collected through a connector (INPUT-1). "slack": the same, read with a Slack token before 0.21.0. */
  kind: "transcript" | "slack" | "thread";
  /** Where it came from: a file path or a permalink. */
  ref: string;
  title: string;
  at: string;
  participants: string[];
  text: string;
  /** Meeting identity hashes (MEET-1), worked out before redaction. Only hashes, never names. */
  keys?: string[];
  /** The same meeting's keys as versions before 0.16.0 computed them, unsalted (PRIV-7). Never written anywhere new. */
  legacyKeys?: string[];
  /** Where a connector-collected transcript came from (COLLECT-1), e.g. granola + its note ID. */
  origin?: { source: string; sourceId: string | null };
  /** Threads only: the approved place it was posted in, as the team listed it. */
  place?: string;
  /**
   * Meetings the synthesis Mac collected for the team (COLLECT-4): the PM who collected it, from the file's `owner`
   * line. The PM may not have been in it, so it feeds their own to-dos only when they were (`attendedBy` in the filter).
   */
  forTeam?: { owner: string | null };
  /**
   * Meetings only: the file's `owner` line, the PM whose collection saved it (COLLECT-1). Says who the PM is when PMX
   * doesn't know yet, for the attendance check on their own to-dos (COLLECT-4). Never sent to the model.
   */
  owner?: string;
  /**
   * F3: the team's approved meeting series this internal meeting matched (its pattern), set by the privacy filter when
   * it let the meeting through at team scope. Synthesis reads it as internal context; it never reaches the tracker.
   */
  series?: string;
  /**
   * F14: the outside email domains of the people in it ("acme.example"), worked out before redaction, so synthesis can
   * name the company a call was with. Never addresses, never names.
   */
  orgs?: string[];
}

/** A conversation from a channel, whichever way it was read. */
export const isThread = (i: { kind: string }) => i.kind === "thread" || i.kind === "slack";

export interface CandidateTask {
  title: string;
  category: string;
  size: Size;
  rationale: string;
  sources: string[];
  /** How each cited source supports the task, in the model's words (PRIV-6). Shown to the PM only, never written to the tracker. */
  support?: Record<string, string>;
  /** Why this size: the rubric cell, the reason and any checks that disagree (`pmx explain`). */
  sizing?: import("./receipt.js").Sizing;
  /** The open task or waiting proposal this is the same need as, by Claude's word (INPUT-2). */
  sameAs?: string | null;
  /**
   * R6: a recently done task this is new work after, by Claude's word. PMX suggests it as a follow-up that links that
   * task only when it says something the done task's description doesn't; otherwise it's that task heard again.
   */
  follows?: string | null;
  /** A roadmap theme from the team's memory/engine/themes.json that the task serves (EQ-38). The PM can change it. */
  theme?: string;
  /**
   * F14: the company each cited source was with, as the source names it, and how it relates to the team. Only names
   * PMX found in that source's own title, text or outside email domain are kept; the tracker's source line says "a
   * customer call with Acme (Nov 20)" from it.
   */
  companies?: Record<string, { name: string; as: CompanyRole | null }>;
  /**
   * PRIV-6: sentences PMX left out of its description, which Linear never gets, and why ("1 sentence that repeated a
   * meeting word for word"). The task itself is kept.
   */
  leftOut?: { sentences: number; why: string };
}

/** How a company in a source relates to the team (F14). An investor, or anyone else, is never named. */
export const COMPANY_ROLES = ["customer", "prospect", "partner"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
