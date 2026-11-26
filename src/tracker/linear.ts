import { SIZES, STATUSES, type Size, type Status, type Task } from "../core/types.js";
import type { Fetch } from "../sources/slack.js";
import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import { meetingDescription, meetingTitle, withWorkflow, type MeetingEntry, type NewTask, type Tracker } from "./types.js";
import { inTarget, pickState, STATE_FOR, stateType, typeOf, type StateTarget, type WorkflowState } from "./states.js";
import { plainMentions } from "./mentions.js";

/**
 * Linear adapter (SCOPE-1). PMX fields are label groups, not custom fields, so no Linear admin
 * is needed (TASK-6). The mapping is shared with the control plane's canvas proxy
 * (docs/control-plane-api.md).
 */
export const GROUPS = { status: "pmx-status", category: "pmx-category", size: "pmx-size", agent: "pmx-agent", kind: "pmx-kind", theme: "pmx-theme", state: "pmx-state" } as const;
type Group = keyof typeof GROUPS;

interface Label {
  id: string;
  name: string;
  group: string | null;
}

export interface LinearOpts {
  /** A personal API key (`lin_api_…`) or a brokered OAuth access token (M5). */
  token: string;
  teamKey: string;
  projectId: string;
  fetch?: Fetch;
}

const ISSUE_FIELDS = `id identifier title description url priority createdAt
  project { id }
  state { id name type }
  assignee { id }
  labels { nodes { id name parent { name } } }`;

/** Linear issue nodes as both the API and the Claude relay snapshot carry them (one mapping, CANVAS-2). */
export const kindOf = (n: any) => n.labels.nodes.find((l: any) => l.parent?.name === GROUPS.kind)?.name ?? "task";

/** The state type PMX last set on this issue, from its `pmx-state` label (TASK-8); null when it hasn't recorded one. */
export const recordedState = (n: any): string | null => stateType(n.labels.nodes.find((l: any) => l.parent?.name === GROUPS.state)?.name);

/** PMX's own status label on an issue node, whatever Linear's state says. */
export const labelStatus = (n: any): Status | null => {
  const v = n.labels.nodes.find((l: any) => l.parent?.name === GROUPS.status)?.name;
  return STATUSES.includes(v as Status) ? (v as Status) : null;
};

/**
 * An issue node as a PMX task. Its status is PMX's label, unless a person moved it in Linear and PMX follows them
 * (TASK-8). A node without a state (a snapshot from before TASK-7) is read from its labels alone, as before.
 */
export function toTask(n: any): Task {
  const t = labelTask(n);
  const type = n.state?.type;
  return typeof type === "string" && kindOf(n) !== "meeting" ? withWorkflow(t, { type, name: n.state?.name ?? "", recorded: recordedState(n) }) : t;
}

function labelTask(n: any): Task {
  const ls: { name: string; group: string | null }[] = n.labels.nodes.map((l: any) => ({ name: l.name, group: l.parent?.name ?? null }));
  const pick = (g: Group) => ls.find((l) => l.group === GROUPS[g])?.name ?? null;
  const status = pick("status");
  const size = pick("size");
  // R23: an identifier Linear made a mention reads as the identifier, in the description and in PMX's comments.
  const desc: string = plainMentions(n.description ?? "");
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: desc,
    url: n.url,
    category: pick("category"),
    size: SIZES.includes(size as Size) ? (size as Size) : null,
    status: STATUSES.includes(status as Status) ? (status as Status) : null,
    priority: n.priority ?? 0,
    agent: pick("agent"),
    sources: [...desc.matchAll(/^pmx:source (\S+)/gm)].map((m) => m[1]!),
    prUrl: ((n.comments?.nodes ?? []) as any[]).map((c) => plainMentions(c.body ?? "").match(/^pmx:pr (\S+)/m)?.[1]).filter(Boolean).at(-1) ?? null,
    createdAt: n.createdAt,
    theme: pick("theme"),
  };
}

export function toMeeting(n: any): MeetingEntry {
  const t = labelTask(n);
  return {
    id: t.id, identifier: t.identifier, url: t.url, title: t.title,
    keys: [...t.description.matchAll(/^pmx:meeting (\S+)/gm)].map((m) => m[1]!),
    status: t.status === "done" ? "done" : t.status === "blocked" ? "blocked" : "running",
    tasks: [...t.description.matchAll(/^pmx:task (\S+)/gm)].map((m) => m[1]!),
    agent: t.agent,
  };
}

export function linearTracker(o: LinearOpts): Tracker {
  const f = o.fetch ?? fetch;
  const auth = o.token.startsWith("lin_api_") ? o.token : `Bearer ${o.token}`;
  let teamId: string | null = null;
  let labels: Label[] | null = null;
  // Looked up once per run (TASK-7, TASK-9): the team's workflow states, and the user this key acts as.
  let states: (WorkflowState & { id: string })[] | null = null;
  let me: string | null | undefined;

  async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await f("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body: any = await res.json();
    if (body.errors?.length) throw new Error(`Linear: ${body.errors.map((e: any) => e.message).join("; ")}`);
    if (!res.ok) throw new Error(`Linear: HTTP ${res.status}`);
    return body.data as T;
  }

  async function team(): Promise<string> {
    if (teamId) return teamId;
    const d = await gql(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: o.teamKey });
    teamId = d.teams.nodes[0]?.id ?? null;
    if (!teamId) throw new Error(`Linear team ${o.teamKey} not found.`);
    return teamId;
  }

  async function allLabels(): Promise<Label[]> {
    if (labels) return labels;
    const id = await team();
    const d = await gql(`query($id: String!) { team(id: $id) { labels(first: 250) { nodes { id name isGroup parent { name } } } } }`, { id });
    labels = d.team.labels.nodes.map((l: any) => ({ id: l.id, name: l.name, group: l.parent?.name ?? (l.isGroup ? null : null) }));
    return labels!;
  }

  /** Finds or creates the label `name` inside group `g` (and the group itself). */
  async function label(g: Group, name: string): Promise<string> {
    const all = await allLabels();
    const groupName = GROUPS[g];
    const hit = all.find((l) => l.group === groupName && l.name === name);
    if (hit) return hit.id;
    const tid = await team();
    let parent = all.find((l) => l.group === null && l.name === groupName);
    if (!parent) {
      const d = await gql(`mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id name } } }`, {
        i: { name: groupName, teamId: tid, isGroup: true },
      });
      parent = { id: d.issueLabelCreate.issueLabel.id, name: groupName, group: null };
      all.push(parent);
    }
    const d = await gql(`mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { issueLabel { id name } } }`, {
      i: { name, teamId: tid, parentId: parent.id },
    });
    const created = { id: d.issueLabelCreate.issueLabel.id, name, group: groupName };
    all.push(created);
    return created.id;
  }

  async function allIssues(): Promise<any[]> {
    const out: any[] = [];
    let after: string | null = null;
    do {
      const d: any = await gql(
        `query($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
        { id: o.projectId, after },
      );
      const page = d.project.issues;
      out.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async function teamStates(): Promise<(WorkflowState & { id: string })[]> {
    if (states) return states;
    const d = await gql(`query($id: String!) { team(id: $id) { states { nodes { id name type position } } } }`, { id: await team() });
    states = (d.team?.states?.nodes ?? []) as (WorkflowState & { id: string })[];
    return states;
  }

  /**
   * Where `target` puts an issue (TASK-7): `move`, the state to change to (null when it's already there), and `ok`, false
   * when the team has no state of that type. Then the issue stays where it is and PMX records that state, so PMX's own
   * write never reads as a person's move.
   */
  async function placeFor(target: StateTarget, current?: { type?: string; name?: string } | null): Promise<{ ok: boolean; move: string | null }> {
    const all = await teamStates();
    if (inTarget(current, target, all)) return { ok: true, move: null };
    const s = pickState(all, target);
    return s ? { ok: true, move: s.id } : { ok: false, move: null };
  }

  /** The Linear user this key or sign-in acts as, so a task an agent on this Mac takes is assigned to its PM (TASK-9). */
  async function viewer(): Promise<string | null> {
    if (me !== undefined) return me;
    const d = await gql(`query { viewer { id } }`);
    const id: string | null = d.viewer?.id ?? null;
    me = id;
    return id;
  }

  /** The issue's label ids with each group in `sets` set to its value (or removed when null); other labels stay. */
  async function labelsWith(issue: any, sets: Partial<Record<Group, string | null>>): Promise<string[]> {
    const groups = Object.keys(sets) as Group[];
    const keep = issue.labels.nodes.filter((l: any) => !groups.some((g) => l.parent?.name === GROUPS[g])).map((l: any) => l.id);
    const add: string[] = [];
    for (const g of groups) if (sets[g]) add.push(await label(g, sets[g]!));
    return [...keep, ...add];
  }

  /** SEC-4: refuse any write to an issue outside the PMX project. */
  async function inProject(id: string): Promise<any> {
    const d = await gql(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} comments(last: 50) { nodes { body } } } }`, { id });
    if (!d.issue) throw new Error(`Task ${id} isn't in Linear.`);
    if (d.issue.project?.id !== o.projectId) throw new Error(`Refusing to write to ${d.issue.identifier}: it is not in the PMX project (SEC-4).`);
    return d.issue;
  }

  async function setGroupLabel(id: string, g: Group, value: string | null): Promise<void> {
    const issue = await inProject(id);
    await update(id, { labelIds: await labelsWith(issue, { [g]: value }) });
  }

  const update = (id: string, i: Record<string, unknown>) => gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i });

  return {
    kind: "linear",
    async list(opts) {
      // Meeting ledger entries are not tasks (MEET-2), and a canceled issue is dropped from the queue (TASK-8).
      const out = (await allIssues()).filter((n) => kindOf(n) !== "meeting" && n.state?.type !== "canceled").map(toTask);
      return opts?.status ? out.filter((t) => t.status !== null && opts.status!.includes(t.status)) : out;
    },
    async get(id) {
      return toTask(await inProject(id));
    },
    async createInbox(t: NewTask) {
      if (hasCanary(t.title + t.description)) throw new Error(CANARY_REFUSAL);
      const status = t.ready ? "ready" : "inbox";
      // TASK-7: created in the team's backlog state, or its first unstarted one (Todo) for Start now, with that state's
      // type recorded (TASK-8). No priority: nothing PMX knows at approval says how urgent a task is (synthesis ranks
      // only within one batch; Start now is a timing choice), so Linear's priority stays the team's own, or the
      // brain's (BRAIN-1), and pull still orders by it (PULL-1).
      const target = STATE_FOR[status]!;
      const stateId = pickState(await teamStates(), target)?.id;
      const labelIds = [await label("status", status), ...(stateId ? [await label("state", typeOf(target))] : []), await label("category", t.category), await label("size", t.size), ...(t.theme ? [await label("theme", t.theme)] : [])];
      const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { ${ISSUE_FIELDS} } } }`, {
        i: { teamId: await team(), projectId: o.projectId, title: t.title, description: t.description, labelIds, ...(stateId ? { stateId } : {}) },
      });
      return toTask(d.issueCreate.issue);
    },
    async setStatus(id, status) {
      const issue = await inProject(id);
      const target = kindOf(issue) === "meeting" ? null : STATE_FOR[status];
      // One save for the label, the state and the state's type recorded, so PMX's own write never reads as a person's
      // move (TASK-8). Blocked moves no state and leaves the record as it is.
      const place = target ? await placeFor(target, issue.state) : null;
      const after = place?.move ? typeOf(target!) : stateType(issue.state?.type);
      await update(id, { labelIds: await labelsWith(issue, { status, ...(target && after ? { state: after } : {}) }), ...(place?.move ? { stateId: place.move } : {}) });
    },
    async setAgent(id, agent) {
      const issue = await inProject(id);
      const user = await viewer();
      // TASK-9: assigned to this key's own user; cleared only when that user is still the assignee.
      const assigneeId = !user ? undefined : agent ? user : issue.assignee?.id === user ? null : undefined;
      await update(id, { labelIds: await labelsWith(issue, { agent }), ...(assigneeId !== undefined ? { assigneeId } : {}) });
    },
    async follow(id, f) {
      const issue = await inProject(id);
      if (labelStatus(issue) !== f.from || issue.state?.type !== f.type) return;
      await update(id, { labelIds: await labelsWith(issue, { status: f.to, state: f.type }) });
      await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: id, body: f.comment } });
    },
    async align(id, status, seen) {
      const issue = await inProject(id);
      // Only while the issue is as PMX read it: a person's move since then is theirs to keep.
      if (kindOf(issue) === "meeting" || issue.state?.type !== seen.type || recordedState(issue) !== seen.recorded) return false;
      const target = STATE_FOR[status];
      const place = target ? await placeFor(target, issue.state) : { ok: true, move: null };
      const after = place.move ? typeOf(target!) : stateType(issue.state?.type);
      if (!place.ok || !after || (!place.move && after === seen.recorded)) return false;
      await update(id, { labelIds: await labelsWith(issue, { state: after }), ...(place.move ? { stateId: place.move } : {}) });
      return true;
    },
    async setSize(id, size) {
      await setGroupLabel(id, "size", size);
    },
    async setCategory(id, category) {
      await setGroupLabel(id, "category", category);
    },
    async setPriority(id, priority) {
      await inProject(id);
      await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { priority } });
    },
    async addNote(id, note) {
      const issue = await inProject(id);
      const description = `${issue.description ?? ""}\npmx:note ${note.replace(/\s+/g, " ").trim()}`;
      await gql(`mutation($id: String!, $i: IssueUpdateInput!) { issueUpdate(id: $id, input: $i) { success } }`, { id, i: { description } });
    },
    async listMeetings() {
      return (await allIssues()).filter((n) => kindOf(n) === "meeting").map(toMeeting);
    },
    async lodgeMeeting(m) {
      if (hasCanary(JSON.stringify(m))) throw new Error(CANARY_REFUSAL);
      const labelIds = [await label("kind", "meeting"), await label("status", "running"), await label("agent", m.agent)];
      const d = await gql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { issue { ${ISSUE_FIELDS} } } }`, {
        i: { teamId: await team(), projectId: o.projectId, title: meetingTitle(m), description: meetingDescription(m), labelIds },
      });
      return toMeeting(d.issueCreate.issue);
    },
    async rewrite(id, r) {
      await inProject(id);
      const canceled = r.cancel ? pickState(await teamStates(), "canceled")?.id : null;
      const i = { ...(r.title ? { title: r.title } : {}), ...(r.description !== undefined ? { description: r.description } : {}), ...(canceled ? { stateId: canceled } : {}) };
      await update(id, i);
    },
    async finishMeeting(id, f) {
      const issue = await inProject(id);
      if (kindOf(issue) !== "meeting") throw new Error(`Refusing to finish ${issue.identifier}: it is a task, not a lodged meeting.`);
      const lines = f.tasks.filter((t) => !plainMentions(issue.description ?? "").includes(`pmx:task ${t}`)).map((t) => `pmx:task ${t}`);
      const description = lines.length ? `${issue.description ?? ""}\n${lines.join("\n")}` : issue.description;
      const completed = f.status === "done" ? pickState(await teamStates(), "completed")?.id : null;
      await update(id, { description, ...(completed ? { stateId: completed } : {}) });
      await setGroupLabel(id, "status", f.status);
      await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: id, body: f.note } });
    },
    async comment(id, body) {
      if (hasCanary(body)) throw new Error(CANARY_REFUSAL);
      await inProject(id);
      await gql(`mutation($i: CommentCreateInput!) { commentCreate(input: $i) { success } }`, { i: { issueId: id, body } });
    },
  };
}
