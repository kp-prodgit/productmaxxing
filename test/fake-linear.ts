// A fake of Linear's GraphQL API for the key path's tests (LINEAR-2): the same shapes test/linear.test.ts fakes, plus
// what a personal API key meets in real use: whose it is, which teams and project it sees, a key Linear rejects, a
// key without Write, the rate limit, and issues filtered by when they changed. Nothing here reaches the network.

/** A made-up key in a real key's shape. Tests grep every file PMX writes for it. */
// Put together at run time, so no key-shaped literal sits in the repo for a secret scanner to flag.
export const FAKE_KEY = ["lin", "api", "TESTONLY" + "q7Zr2Lw9XkVb4NmPd6TsHy3JfGc"].join("_");

const STATES = [
  { id: "S-back", name: "Backlog", type: "backlog", position: 0 }, { id: "S-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "S-prog", name: "In Progress", type: "started", position: 2 }, { id: "S-rev", name: "In Review", type: "started", position: 3 },
  { id: "S-done", name: "Done", type: "completed", position: 4 }, { id: "S-cxl", name: "Canceled", type: "canceled", position: 5 },
];

export interface FakeLinearOpts {
  viewer?: string;
  /** The teams the key sees, by key. */
  teams?: { key: string; name: string }[];
  /** The projects the key sees, by id. */
  projects?: { id: string; name: string }[];
  /** The time Linear stamps a change with; tests move it. */
  now?: () => Date;
}

export function fakeLinear(o: FakeLinearOpts = {}) {
  const teams = o.teams ?? [{ key: "ACME", name: "Acme Product" }];
  const projects = o.projects ?? [{ id: "proj-1", name: "PMX" }];
  const clock = o.now ?? (() => new Date());
  const labels: { id: string; name: string; isGroup: boolean; parent: { name: string } | null }[] = [];
  const issues = new Map<string, any>();
  /** Every request: the operation, its variables, and whether it carried the key. */
  const calls: { op: string; vars: any; query: string }[] = [];
  const auths = new Set<string>();
  let n = 0;
  /** What Linear answers next: as usual, a rejected key, a key without Write, the rate limit, or an outage. */
  const mode: { now: "ok" | "rejected" | "read-only" | "limited" | "down"; resetAt?: Date; refuseTitle?: RegExp } = { now: "ok" };

  const labelNodes = (ids: string[]) => ({ nodes: ids.map((id) => labels.find((l) => l.id === id)!).map((l) => ({ id: l.id, name: l.name, parent: l.parent })) });
  const state = (id: string | undefined) => { const s = STATES.find((x) => x.id === id); return s ? { id: s.id, name: s.name, type: s.type } : null; };
  const view = (i: any) => ({ id: i.id, identifier: i.identifier, title: i.title, description: i.description, url: i.url, priority: i.priority, createdAt: i.createdAt, project: i.project, labels: labelNodes(i.labelIds), comments: { nodes: i.comments.map((body: string) => ({ body })) }, state: state(i.stateId), assignee: i.assigneeId ? { id: i.assigneeId } : null });
  const find = (id: string) => issues.get(id) ?? [...issues.values()].find((i) => i.identifier === id) ?? null;
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  const fail = (message: string, code: string, status = 200, headers: Record<string, string> = {}) => answer(status, { errors: [{ message, extensions: { code } }] }, headers);

  const f = (async (_url: string, init: any) => {
    auths.add(String(init.headers.authorization));
    const { query, variables: v } = JSON.parse(init.body);
    const kind = query.match(/^\s*(query|mutation)/)![1] as "query" | "mutation";
    const op = query.match(/^\s*(?:query|mutation)[^{]*\{\s*(\w+)/)![1] as string;
    calls.push({ op, vars: v, query });
    if (mode.now === "down") throw new TypeError("fetch failed");
    if (mode.now === "rejected") return fail("Authentication required, not authenticated", "AUTHENTICATION_ERROR", 401);
    if (mode.now === "limited") return fail("Rate limit exceeded", "RATELIMITED", 400, { "x-ratelimit-requests-reset": String((mode.resetAt ?? new Date(clock().getTime() + 20 * 60000)).getTime()) });
    if (mode.now === "read-only" && kind === "mutation") return fail("Invalid scope: `write` required", "FORBIDDEN", 403);
    let data: any;
    switch (op) {
      case "viewer": {
        const keys: string[] | undefined = v.keys;
        data = { viewer: { id: "user-me", name: o.viewer ?? "Sam Lee" } };
        if (/teams\(/.test(query)) data.teams = { nodes: teams.filter((t) => !keys || keys.includes(t.key)).map((t) => ({ id: `team-${t.key}`, key: t.key, name: t.name })) };
        if (/project\(/.test(query)) {
          const p = projects.find((x) => x.id === v.id);
          if (!p) return fail("Entity not found: Project", "INPUT_ERROR");
          data.project = { id: p.id, name: p.name };
        }
        break;
      }
      case "teams": {
        const want = v.key ?? v.keys;
        data = { teams: { nodes: teams.filter((t) => (Array.isArray(want) ? want.includes(t.key) : t.key === want)).map((t) => ({ id: `team-${t.key}`, key: t.key, name: t.name })) } };
        break;
      }
      case "team": data = { team: /states/.test(query) ? { states: { nodes: STATES } } : { labels: { nodes: labels } } }; break;
      case "issueLabelCreate": {
        const parent = v.i.parentId ? { name: labels.find((l) => l.id === v.i.parentId)!.name } : null;
        const l = { id: `L${++n}`, name: v.i.name, isGroup: !!v.i.isGroup, parent };
        labels.push(l);
        data = { issueLabelCreate: { issueLabel: { id: l.id, name: l.name } } };
        break;
      }
      case "issueCreate": {
        if (mode.refuseTitle?.test(v.i.title)) return fail("Title is not allowed", "INVALID_INPUT");
        const id = `I${++n}`;
        const at = clock().toISOString();
        issues.set(id, { id, identifier: `ACME-${n}`, title: v.i.title, description: v.i.description, url: `https://linear.app/x/${id}`, priority: v.i.priority ?? 0, createdAt: at, updatedAt: at, project: { id: v.i.projectId }, labelIds: v.i.labelIds ?? [], comments: [], stateId: v.i.stateId ?? "S-back", assigneeId: null });
        data = { issueCreate: { issue: view(issues.get(id)) } };
        break;
      }
      case "issue": { const i = find(v.id); data = { issue: i ? view(i) : null }; break; }
      case "issueUpdate": {
        const i = find(v.id);
        for (const k of ["labelIds", "stateId", "assigneeId", "priority", "description", "title"]) if (k in v.i) i[k] = v.i[k];
        i.updatedAt = clock().toISOString();
        data = { issueUpdate: { success: true, issue: view(i) } };
        break;
      }
      case "commentCreate": { const i = find(v.i.issueId); i.comments.push(v.i.body); i.updatedAt = clock().toISOString(); data = { commentCreate: { success: true } }; break; }
      case "project": {
        if (!projects.some((p) => p.id === v.id)) return fail("Entity not found: Project", "INPUT_ERROR");
        const all = [...issues.values()].filter((i) => i.project.id === v.id).filter((i) => !v.since || i.updatedAt > v.since);
        data = { project: { issues: { nodes: all.map(view), pageInfo: { hasNextPage: false, endCursor: null } } } };
        break;
      }
      default: throw new Error(`fake Linear: unexpected ${op}`);
    }
    return answer(200, { data });
  }) as unknown as typeof fetch;

  /** An issue already in Linear, as a teammate or an earlier PMX made it: labels as [group, name] pairs. */
  const seed = (title: string, pairs: [string, string][] = [], over: Record<string, unknown> = {}) => {
    const labelIds = pairs.map(([group, name]) => {
      let parent = labels.find((l) => l.isGroup && l.name === group);
      if (!parent) { parent = { id: `L${++n}`, name: group, isGroup: true, parent: null }; labels.push(parent); }
      let l = labels.find((x) => x.parent?.name === group && x.name === name);
      if (!l) { l = { id: `L${++n}`, name, isGroup: false, parent: { name: group } }; labels.push(l); }
      return l.id;
    });
    const id = `I${++n}`;
    const at = clock().toISOString();
    const i = { id, identifier: `ACME-${n}`, title, description: "", url: `https://linear.app/x/${id}`, priority: 0, createdAt: at, updatedAt: at, project: { id: projects[0]?.id ?? "proj-1" }, labelIds, comments: [] as string[], stateId: "S-back", assigneeId: null, ...over };
    issues.set(id, i);
    return i;
  };
  /** A teammate's change in Linear itself. */
  const touch = (id: string, change: Record<string, unknown>) => { Object.assign(find(id), change, { updatedAt: clock().toISOString() }); };
  const labelOf = (id: string, group: string) => find(id).labelIds.map((x: string) => labels.find((l) => l.id === x)!).find((l: any) => l.parent?.name === group)?.name ?? null;
  const ops = () => calls.map((c) => c.op);
  return { f, labels, issues, calls, auths, mode, seed, touch, labelOf, ops, find };
}
