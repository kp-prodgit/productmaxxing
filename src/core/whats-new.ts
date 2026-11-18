import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { paths } from "./paths.js";
import { loadState, updateState } from "./state.js";
import { compareVersions, currentVersion } from "./version.js";

/**
 * What's new, per release (NEW-1). Every version PMX ships has an entry here; a test fails the build without
 * one, so no feature reaches users unannounced. Each item says what changed in the PM's terms and, where
 * there is one, the command to try. Newest first. CHANGELOG.md keeps the full detail.
 */
export interface ReleaseNote {
  version: string;
  date: string;
  headline: string;
  items: { what: string; try?: string }[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.33.0", date: "2026-11-18", headline: "A Mac mark on Connect",
    items: [
      { what: "Connect, which has PMX ask you in a dialog on your Mac, now carries a small Mac sign: the same one PMX Engine's studio puts on its approvals. Your /pmx-flow page shows it once you publish it again; pmx doctor says when.", try: "pmx doctor" },
    ],
  },
  {
    version: "0.32.0", date: "2026-11-18", headline: "Roadmap themes as Linear labels",
    items: [
      { what: "Where your team uses PMX Engine, proposed tasks can carry a roadmap theme as a Linear label. PMX suggests one of your team's open themes; you keep, change or clear it before approving.", try: "pmx proposals" },
    ],
  },
  {
    version: "0.31.0", date: "2026-11-18", headline: "Your team's released strategy, as team memory",
    items: [
      { what: "Where your team uses PMX Engine, the head of product can put what the PMs' roadmap page shows into memory/engine/ in your team's repo, by pull request. Agents draft against it, and a task never repeats it word for word.", try: "pmx doctor" },
    ],
  },
  {
    version: "0.30.0", date: "2026-11-18", headline: "A link to your team's roadmap",
    items: [
      { what: "When your team has a roadmap page for PMs in PMX Engine, the nav shows Roadmap under Team. The head of product adds its link to pmx.config.json; PMX holds only the link.", try: "pmx open roadmap" },
    ],
  },
  {
    version: "0.29.0", date: "2026-11-18", headline: "The brain is free on your Macs",
    items: [
      { what: "The brain needs no license: it runs on one of your team's Macs, on your own Claude plan. Turn it on with a \"brain\" block in pmx.config.json, in a reviewed pull request; your org's admin policy still decides when it sets the brain.", try: "pmx brain --status" },
      { what: "A license is now needed only for cloud leases, so pmx doctor no longer reports a missing one otherwise." },
    ],
  },
  {
    version: "0.28.0", date: "2026-11-18", headline: "One door to PMX Engine",
    items: [
      { what: "pmx open opens your PMX workspace on this Mac. Where PMX Engine is installed, the nav also offers Studio, which opens the head of product's studio in its own tab.", try: "pmx open" },
      { what: "On a Mac with PMX Engine, pmx doctor and pmx whats-new include Engine's checks and notes, so there is one place to look. Nothing changes on a Mac without it." },
    ],
  },
  {
    version: "0.27.0", date: "2026-11-18", headline: "One look with PMX Engine",
    items: [
      { what: "The team board now looks like the rest of PMX: the same colours and type as your Workspace and as PMX Engine's studio. Publish it again with /pmx-board in the Claude app to see it." },
      { what: "Each collection run marks the files it saves, and the check after it names any new file without the mark, so you can tell your scheduled task's files from anything else. Nothing is removed." },
    ],
  },
  {
    version: "0.26.0", date: "2026-11-17", headline: "Your team defines its own kinds of work",
    items: [
      { what: "Add a kind of work your team needs, like a prototype or a stakeholder update: fill in what it produces, when PMX should propose it, its sections and steps. It goes to your team as one pull request, and once merged every PM on the team has it. On the board it's Settings → Kinds of work → New kind of work.", try: "pmx jobs template" },
      { what: "Your team can require a kind of work, so every PM's agent takes it." },
      { what: "Each Mac now picks up merged team changes on its own every ten minutes or so, so everyone has the same kinds of work and settings." },
      { what: "A prototype job can build a working prototype (files or a live preview link) instead of a written draft. It has to be a reviewed skill in your team's repo." },
      { what: "Teams can share jobs through Linear, and can pin each shared job to its exact content before an agent runs it.", try: "pmx skills sync" },
    ],
  },
  {
    version: "0.25.1", date: "2026-11-13", headline: "The board on this Mac shows your settings as they are now",
    items: [
      { what: "The board from `pmx flow --web` kept the settings it started with, so a change made in the Claude app or by a command didn't show there, and saving on it could undo that change. It now reads your settings fresh each time.", try: "pmx flow --web" },
    ],
  },
  {
    version: "0.25.0", date: "2026-11-12", headline: "Tasks are proposed on their own, and an empty Inbox says why",
    items: [
      { what: "PMX now proposes tasks from your customer calls in the background even if your team hasn't picked a synthesis Mac. Each task still waits for your approval before it reaches Linear." },
      { what: "When no tasks are waiting, your Inbox says why (not run yet, nothing new, or every meeting kept out as internal) and what happened to each recent meeting, with a Run synthesis button and its cost.", try: "pmx proposals" },
      { what: "To-dos stay on this Mac; tasks go to Linear after you approve them. If you'd like to track your own commitments in Linear too, you can now turn that on.", try: "pmx todo --linear on" },
      { what: "`pmx todo` and the board's to-do views show to-dos from the last 7 days' meetings by default; pick another period with --days or --since (or From meetings in on the board), up to 90 days, or all of them.", try: "pmx todo --days 30" },
      { what: "Fixes: `pmx digest --review` keeps the draft when it can't ask you, `pmx todo --refresh` reads the last 7 days, and `pmx flow --web` reopens the board that's already running." },
    ],
  },
  {
    version: "0.24.1", date: "2026-11-12", headline: "The Flow map is back, and your PMX page in Claude follows updates",
    items: [
      { what: "Flow is back in the left menu: the map of every step from your meetings to Linear and the agents, what each arrow carries and how much moved, with a panel explaining each step. Everything else stays where it was.", try: "pmx flow --web, then Flow" },
      { what: "PMX's server in the Claude app now switches to a newly installed pmx by itself. Coming from 0.24.0 or older? Quit the Claude app completely (⌘Q) and open it again once, so your PMX page there stops talking to the old server.", try: "pmx doctor" },
      { what: "Pages you published in Claude with /pmx-flow or /pmx-board keep the old code until they're published again. After any update, PMX now says which ones, on the page itself, in the Claude app and in its own output, and a Claude session that runs the update publishes them again itself. Each keeps its link.", try: "/pmx-flow in the Claude app" },
    ],
  },
  {
    version: "0.24.0", date: "2026-11-12", headline: "Fireflies is read through its Claude connector",
    items: [
      { what: "PMX reads Fireflies the way its connector is built: your meetings since the last run, the transcript word for word without timestamps, never Fireflies' AI summary, and never its tools that share or change meetings.", try: "pmx sources add Fireflies" },
    ],
  },
  {
    version: "0.23.0", date: "2026-11-11", headline: "PMX is a workspace you work in, right inside Claude",
    items: [
      { what: "A new layout: a left menu with Inbox (tasks to approve, the digest, fixes), Today, Upcoming, Anytime and Logbook, then Plan, Digest, Agents, Status and Settings. Approving or ticking off waits a few seconds so you can undo it.", try: "pmx flow --web" },
      { what: "The /pmx-flow page in Claude now does everything the Mac page does, with nothing running in Terminal: click Connect once and allow it on your Mac. Type /pmx-flow in the Claude app to update your page." },
      { what: "Add your own to-dos, and move any to-do to Today, This Evening, Someday or a date." },
      { what: "Settings has its own screen: grouped sections, Save Changes, and a review of every change before it's saved." },
    ],
  },
  {
    version: "0.22.0", date: "2026-11-09", headline: "Google Meet's notetaker is an input, and links point to productmaxxing.ai",
    items: [
      { what: "PMX reads Google Meet calls through your Google Drive connector: the transcript in each meeting's \"Notes by Gemini\" or \"Transcript\" doc, word for word. Gemini's summary alone isn't a transcript, so turn on transcripts in Meet to have a call read.", try: "pmx sources add \"Google Meet\"" },
      { what: "A meeting app you add (Google Meet, Granola…) is read every time, alongside the first one connected, instead of only when nothing earlier in the list is connected." },
      { what: "PMX's links now go to https://productmaxxing.ai: the docs link in pmx --help, the Claude plugin's homepage, a new team repo's README and the PMX cloud sign-in." },
    ],
  },
  {
    version: "0.21.1", date: "2026-11-09", headline: "The npm page links to productmaxxing.ai",
    items: [
      { what: "The Homepage link on PMX's npm page now goes to https://productmaxxing.ai. Nothing else changed." },
    ],
  },
  {
    version: "0.21.0", date: "2026-11-08", headline: "Any Claude connector feeds PMX: Slack channels, Momentum and more, with no duplicate tasks",
    items: [
      { what: "A new Sources tab shows where PMX listens and whether each source works. Add a recorder like Momentum or Gong, or propose Slack channels for your team, with no token: Claude reads them through the connectors you already have.", try: "pmx flow --web" },
      { what: "Slack is read through your Slack connector in Claude, only in the channels your team approved and never DMs. PMX deletes anything the collection saved from another place.", try: "pmx sources" },
      { what: "No duplicates: a call saved by two recorders is read once, and a need that's already open or waiting for you gets the new sources instead of a second task." },
    ],
  },
  {
    version: "0.20.0", date: "2026-11-08", headline: "The board is your PMX home: Today, your digest, and every step PMX takes",
    items: [
      { what: "Today opens first: tasks to approve, drafts to review, your digest and your to-dos in one place, with what happened this week beside them. Tick a to-do done right there.", try: "pmx flow --web" },
      { what: "Your weekly digest has its own tab: read it with clickable citations, edit it, then approve it to share with your team, or reject it. Choose its day and Slack DM under Settings." },
      { what: "Automations lists every step PMX takes, automatic or yours, with when it last ran, what came of it and when it runs next. Run a step now, or turn on automatic runs, with one click instead of Terminal." },
      { what: "Agent work shows each kind of work with its quality and a switch for whether your agent takes it; Privacy and Settings split the old Rules tab. Old links still work." },
    ],
  },
  {
    version: "0.19.0", date: "2026-11-08", headline: "Categories follow the product's life, from problem to production",
    items: [
      { what: "Four new categories: problem brief, build brief, validation plan and validation readout. A build brief ends in a prompt you can hand to Claude Code; validation counts only paid pilots and subscriptions. New teams get them by default; existing teams add a category's line to pmx.config.json by pull request.", try: "pmx flow --web" },
      { what: "Every product category's skill shares the same drafting rules: the problem before any solution, what users ask for as a signal, every claim cited or marked as an assumption, and decisions left to you, marked \"PM decides\"." },
      { what: "Research synthesis adds Insights, competitive analysis adds a Switching bar, and specs add Validated by. The Categories tab groups categories by stage, and Claude now picks a category from its description, not its name alone." },
    ],
  },
  {
    version: "0.18.0", date: "2026-11-08", headline: "A Categories tab shows each kind of work end to end",
    items: [
      { what: "The pipeline board has a Categories tab. Each category reads left to right: the Linear label and its tasks now, the skill Claude follows, the draft file and the sections it must have, and how the team has judged its drafts. Each size's wording sits underneath.", try: "pmx flow --web" },
      { what: "Linear tasks in a category no skill handles are listed, since agents skip them. \"Add a category\" lists the three files a new category needs." },
      { what: "Skill cards link to their category, and the Ready, Agent works, To review and Done steps on the map link to the categories." },
    ],
  },
  {
    version: "0.17.0", date: "2026-11-08", headline: "The pipeline board shows you where to act",
    items: [
      { what: "Click a step on the map and its detail opens beside it (or scrolls into view on a narrow window), with what's waiting there and what you can do. The cards at the top take you straight to it.", try: "pmx flow --web" },
      { what: "Approve or drop proposed tasks, and accept, reject or ask for a redo on agent drafts, right on the board. Dropping waits a few seconds with an Undo.", try: "pmx flow --web" },
      { what: "Each problem says how to fix it, with a command to copy or a button to the setting. A failed privacy check now shows at the top.", try: "pmx flow --web" },
      { what: "Published the board in Claude? Type /pmx-flow there again to update it. Its Rules tab now turns your changes into commands to copy." },
    ],
  },
  {
    version: "0.16.2", date: "2026-11-08", headline: "The board's Skills tab lists your skills again",
    items: [
      { what: "The Skills tab on the pipeline board showed \"[object HTMLDivElement]\" instead of your skills. It now lists them in their groups, with run counts. Published the board in Claude? Type /pmx-flow there again to update it.", try: "pmx flow --web" },
    ],
  },
  {
    version: "0.16.1", date: "2026-11-07", headline: "Setup connects the board in Claude",
    items: [
      { what: "`pmx init` now offers to connect the /pmx-flow board in the Claude app to PMX on this Mac, so there's no separate step. Already connected? It's kept up to date with this pmx.", try: "pmx doctor" },
    ],
  },
  {
    version: "0.16.0", date: "2026-11-07", headline: "The pipeline board",
    items: [
      { what: "One board for your skills, scheduled tasks, a live map of what travels from your meetings to Linear and back, and every rule. Approve proposed tasks and change rules right there.", try: "pmx flow --web" },
      { what: "Choose what each source may feed: nothing, only your to-dos, or to-dos and Linear tasks.", try: "pmx sources" },
      { what: "Nothing about your meetings goes to Linear any more: processed meetings are recorded in your PMX repo under keyed IDs. If you published /pmx-flow before, type /pmx-flow in the Claude app to update it." },
    ],
  },
  {
    version: "0.15.0", date: "2026-11-07", headline: "Product Git is now ProductMaxxing",
    items: [
      { what: "New name: the repo is kp-prodgit/productmaxxing and the npm package is productmaxxing. The pmx command, ~/.pmx, your PMX repo and your settings are unchanged." },
      { what: "This Mac moved its keychain items, its npm package and its background job to the new names by itself. `pmx doctor` warns if anything is left under the old ones.", try: "pmx doctor" },
    ],
  },
  {
    version: "0.14.0", date: "2026-11-07", headline: "Private meetings stay private, and you approve what reaches Linear",
    items: [
      { what: "Tasks PMX proposes now wait on your Mac. See each exactly as Linear would get it, then approve or drop it. Nothing reaches Linear before you approve.", try: "pmx proposals" },
      { what: "Task descriptions are short summaries: no transcript excerpts, meeting titles or quotes. Processed meetings show in Linear under an opaque ID, not their title." },
      { what: "1:1s, hiring interviews and internal-only meetings never reach team tasks. PMX needs your company's email domain to tell colleagues from customers: run `pmx doctor`, and if it asks, run `pmx init` again.", try: "pmx doctor" },
      { what: "Older versions may have written meeting excerpts or titles to Linear. List them, then rewrite them in today's form.", try: "pmx linear written, then pmx linear tidy" },
      { what: "On a Claude plan there's no dollar cap of your own by default, and every run checks the same budget. A cap of $0 now says PMX is paused.", try: "pmx budget" },
    ],
  },
  {
    version: "0.13.0", date: "2026-11-07", headline: "No more working hours",
    items: [
      { what: "PMX works whenever this Mac is on and awake, within your daily spend cap. `pmx init` no longer asks for working days or hours, and hours you saved before are ignored: nothing to change." },
      { what: "The README's Updating section says exactly how to update each kind of existing machine.", try: "pmx update" },
    ],
  },
  {
    version: "0.12.0", date: "2026-11-07", headline: "PMX tells you what's new after every update",
    items: [
      { what: "After an update, the first pmx command shows what changed since your last version, once. Claude Code sees it too when it runs the update.", try: "pmx whats-new" },
      { what: "`pmx update` prints what's new as soon as it installs, and the update notification names the headline." },
    ],
  },
  {
    version: "0.11.0", date: "2026-11-07", headline: "See where your data went",
    items: [
      { what: "A flow view of every meeting PMX read or held, the tasks it proposed, the Linear issues they became, agent runs, skills and spend. Click anything to trace its path.", try: "pmx flow --web" },
      { what: "An audit that checks no held meeting reached Linear, and fake confidential \"canary\" meetings every run must hold. `pmx doctor` fails if one gets through." },
      { what: "The same view as a live Claude artifact that reads your Mac.", try: "pmx mcp --install, then pmx flow --install-skill, then /pmx-flow in the Claude app" },
      { what: "Add a meeting title, person or channel to your do-not-read list, with a preview of what it would have held.", try: "pmx never-ingest add --title \"…\"" },
      { what: "PMX's own Claude profile now signs in with `pmx claude login`; `pmx login` is the hosted-app sign-in again." },
    ],
  },
  {
    version: "0.10.1", date: "2026-11-06", headline: "Runs that fail say why",
    items: [
      { what: "A failed run shows Claude's own error, and PMX's Claude profile has its own sign-in.", try: "pmx claude login" },
      { what: "The background job finds Claude Code wherever your shell does; run `pmx init` again to re-register an older job." },
      { what: "`pmx status` and `pmx doctor` show the background job's last pass and each scheduled task's last run.", try: "pmx schedule" },
    ],
  },
  {
    version: "0.10.0", date: "2026-11-06", headline: "A solo install that works",
    items: [
      { what: "A prebuilt release with checksums, and an install guide Claude Code follows (INSTALL.md)." },
      { what: "`pmx init` checks every answer and shows a summary before saving anything." },
      { what: "`pmx doctor --json` for scripts and Claude; `pmx update --latest` installs the newest release.", try: "pmx doctor" },
    ],
  },
];

const newer = (a: string, b: string) => (compareVersions(a, b) ?? 0) > 0;

/** Notes for versions after `after` up to and including `upTo`, newest first. `after` null means just `upTo`'s own. */
export function notesBetween(after: string | null, upTo = currentVersion()): ReleaseNote[] {
  return RELEASE_NOTES.filter((n) => !newer(n.version, upTo) && (after ? newer(n.version, after) : n.version === upTo));
}

export function formatNotes(notes: ReleaseNote[]): string {
  if (!notes.length) return "Nothing new.";
  return notes.map((n) => [`What's new in pmx ${n.version}: ${n.headline}`, ...n.items.map((i) => `  • ${i.what}${i.try ? `\n    Try: ${i.try}` : ""}`)].join("\n")).join("\n\n");
}

/** Called just before an install replaces this pmx: the new one shows what changed since this version. */
export async function markUpdatingFrom(version = currentVersion()): Promise<void> {
  await updateState((s) => {
    const since = s.whatsNew?.since;
    s.whatsNew = { seen: s.whatsNew?.seen ?? null, since: since && newer(version, since) ? since : version };
  }).catch(() => {});
}

/** A fresh install starts up to date: nothing to announce. */
export async function markSeen(version = currentVersion()): Promise<void> {
  await updateState((s) => (s.whatsNew = { seen: version, since: null })).catch(() => {});
}

/**
 * What this Mac hasn't been told yet. After an update through PMX it knows the old version. After a manual
 * install over a pmx from before 0.12.0 it doesn't, so it covers releases since this Mac was set up, at most
 * the last three. Before `pmx init` there's nothing to announce.
 */
export async function pendingNotes(o: { installedAt?: string | null } = {}): Promise<ReleaseNote[]> {
  const s = await loadState();
  const from = s.whatsNew?.since ?? s.whatsNew?.seen ?? null;
  if (from) return notesBetween(from);
  if (!(await stat(paths.config()).then(() => true, () => false))) return [];
  const since = o.installedAt ?? null;
  return RELEASE_NOTES.filter((n) => !newer(n.version, currentVersion()) && (!since || n.date >= since.slice(0, 10))).slice(0, 3);
}

/** Commands that never show the notes: machine protocols, the background job, and the ones that handle it themselves. */
export const QUIET_COMMANDS = new Set(["tick", "mcp", "whats-new", "uninstall"]);

/** Shows pending notes once, on stderr so JSON on stdout stays clean, then marks them seen. Never throws. */
export async function announceOnce(write: (s: string) => void, o: { installedAt?: string | null; pages?: () => Promise<string | null> } = {}): Promise<void> {
  try {
    const notes = await pendingNotes(o);
    // The pages this Mac published in Claude still run the old code: say so with the notes, so Claude publishes them again.
    const pages = notes.length && o.pages ? await o.pages().catch(() => null) : null;
    if (notes.length) write(`${formatNotes(notes)}\n\nSee this again with \`pmx whats-new\`.\n${pages ? `\n${pages}\n` : ""}`);
    if (notes.length || (await stat(paths.config()).then(() => true, () => false))) await markSeen();
  } catch {}
}

/**
 * Asks the pmx that was just installed what's new since `from`. The running process is the old version and
 * doesn't know the new notes; the new one is in npm's global bin. Null when it can't be asked.
 */
export async function newVersionNotes(exec: Exec, from: string): Promise<string | null> {
  const prefix = (await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 })).stdout.trim();
  if (!prefix) return null;
  const r = await exec(join(prefix, "bin", "pmx"), ["whats-new", "--since", from], { timeoutMs: 30000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
