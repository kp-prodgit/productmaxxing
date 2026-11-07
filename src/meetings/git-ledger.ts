import type { Git } from "../core/git.js";
import type { MeetingEntry, NewMeeting } from "../tracker/types.js";

const PREFIX = "refs/pmx/meetings";
const MIRROR = "refs/pmx/remote-meetings";
const ZERO = "0000000000000000000000000000000000000000";

/**
 * The team's record of processed meetings (MEET-2), in the PMX repo instead of Linear (0.16.0, PRIV-7). Each meeting
 * PMX finished is a parentless commit at `refs/pmx/meetings/<first key>` holding its salted identity hashes, the date
 * and who processed it. Only people with the PMX repo can see it, and it says nothing about the meeting itself.
 * Claiming a meeting while it's processed stays with the lease; this records only that it's done.
 */
export interface MeetingLedger {
  list(): Promise<MeetingEntry[]>;
  done(m: NewMeeting & { tasks: number }): Promise<void>;
}

export function gitMeetingLedger(git: Git): MeetingLedger {
  const base = async () => {
    if (!(await git.hasRemote())) return PREFIX;
    await git.raw(["fetch", "--quiet", "--prune", "origin", `+${PREFIX}/*:${MIRROR}/*`]);
    return MIRROR;
  };
  return {
    async list() {
      const out = await git.raw(["for-each-ref", "--format=%(refname)%00%(contents)%00", await base()]);
      if (out.code !== 0) return [];
      const parts = out.stdout.split("\0");
      const entries: MeetingEntry[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const ref = parts[i]!.trim();
        try {
          const m = JSON.parse(parts[i + 1]!) as NewMeeting & { tasks: number };
          if (!Array.isArray(m.keys) || !m.keys.length) continue;
          entries.push({ id: ref, identifier: ref.split("/").pop()!, url: "", title: `Processed meeting ${m.keys[0]!.slice(0, 9)}`, keys: m.keys, status: "done", tasks: [], agent: m.agent ?? null });
        } catch {}
      }
      return entries;
    },
    async done(m) {
      const tree = await git.ok(["mktree"], { input: "" });
      const msg = JSON.stringify({ keys: m.keys, at: m.at, agent: m.agent, tasks: m.tasks });
      const sha = await git.ok(["-c", "user.name=pmx", "-c", "user.email=pmx@localhost", "commit-tree", tree, "-m", msg]);
      const ref = `${PREFIX}/${m.keys[0]}`;
      // Create-only: if a teammate recorded it first, theirs stands.
      if (await git.hasRemote()) await git.raw(["push", "--quiet", "--porcelain", "origin", `${sha}:${ref}`]);
      else await git.raw(["update-ref", ref, sha, ZERO]);
    },
  };
}

/** For tests and machines without a PMX repo. */
export function memoryMeetingLedger(): MeetingLedger & { entries: MeetingEntry[] } {
  const entries: MeetingEntry[] = [];
  return {
    entries,
    async list() { return entries.map((e) => ({ ...e })); },
    async done(m) {
      if (entries.some((e) => e.keys[0] === m.keys[0])) return;
      entries.push({ id: `mem:${m.keys[0]}`, identifier: m.keys[0]!, url: "", title: `Processed meeting ${m.keys[0]!.slice(0, 9)}`, keys: [...m.keys], status: "done", tasks: [], agent: m.agent });
    },
  };
}
