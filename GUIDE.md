# The PMX guide for Claude

`pmx guide` prints this file for the pmx installed on this Mac. It's written for **you, Claude**, helping a product manager (PM) install, set up, update or check ProductMaxxing (PMX). Read all of it before you act. Then work from `pmx checklist --json`, which says what's actually done on this Mac. Never work from memory or guesses.

The PM usually doesn't know which parts of PMX exist, which of them run on their own, or what's still missing. Your job is to make that plain at every step: where they stand, what runs, what's next and who does it.

## Words PMX uses

PMX and PMX Engine use the same few words for the same things, on the page, the board, in Terminal and in this guide. Use them with the PM too, even where an older word slips out of a command, a setting or the PM's own memory.

| Say | Instead of | What it is |
|---|---|---|
| **Task** | proposal, proposed task, issue | One sized piece of work. A new task waits on the PM's Mac until they start it, keep it for later or drop it; after that it's a task in Linear. |
| **Backlog** | pool | The team's tasks kept for later, in Linear. No agent takes one until someone moves it to Ready. |
| **Draft** | run output | What an agent wrote for a task, waiting for the PM's review. |
| **Run** | pass, tick, pull | PMX's background run, every 30 minutes while the Mac is awake. An agent run is different: it drafts one task. Say which one you mean. |
| **Page** | hub | PMX's page, the PM's workspace; in PMX Engine, the page each audience reads. |
| **Release** | edition, leg, stage, carry | What the head of product publishes in PMX Engine, and its way to each audience. |
| **Audience** | function, preset, group | Who a PMX Engine release is for, such as Engineering or Sales. |

Only the words people read changed. Commands, flags, settings, JSON fields, file names and Linear label names keep their names: `pmx proposals`, `pmx tick`, `proposals.json`, `pmx-status/inbox` (the backlog). Say the new word and type the old name.

---

## 1. What PMX is

PMX turns a PM's customer meetings into small, sized, cited tasks. Agents draft those tasks (specs, research summaries, competitive notes, prototypes), and the PM reviews the drafts like pull requests. A team shares one PMX setup in a git repo. Each PM runs PMX on their own Mac.

### The flow, and its human gates

| Step | What happens | Where | Who |
|---|---|---|---|
| 1. Collect | A Claude app scheduled task saves new meeting transcripts from the PM's meeting app (Granola, Fireflies, Google Meet through Drive…) into `~/.pmx/transcripts`. Nothing leaves the Mac. | Claude app, weekdays 12:30 and 17:30 | automatic |
| 2. Suggest | On PMX's background run, every 30 minutes, PMX applies the **privacy rules** (internal-only meetings, one-on-ones, hiring, pay and more are held back), then asks Claude, with no tools, to suggest sized tasks that cite the meetings the rules let through. | this Mac | automatic |
| 3. **Approve** (privacy gate) | New tasks wait on the Mac until the PM decides each one: **Start now**, **Later** or **Drop**. **Nothing reaches Linear before that.** Tasks go to Linear carrying only source IDs (`pmx:source T14`), never quotes. | PMX's page (Needs you) or `pmx proposals start` / `approve` / `drop` | the PM |
| 4. Backlog | A task approved for later (Later, or Approve when Start now is off) lands in the team's **backlog** in Linear (label `pmx-status/inbox`). No agent touches the backlog. | Linear | |
| 5. **Ready** (work gate) | **Start now** creates the task in **Ready** (`pmx-status/ready`) at once; through the Claude relay it becomes Ready at the next sync. Backlog tasks become Ready when someone moves them on the team board. This decides what agents spend budget on. A team where a teammate decides what agents take sets `"approve": { "startNow": false }` in `pmx.config.json`: then Start now isn't offered and only the team board makes tasks Ready. | PMX's page (Start now), team board (`/pmx-board`) or Linear | the PM, a teammate (or the brain, if the team turned it on) |
| 6. Agent run | On PMX's background run, every 30 minutes, the agent takes the top Ready task that fits the budget and the review cap. The agent run is Claude Code headless in a fresh git worktree, with PMX's own clean Claude profile (no personal memory, no connectors, file tools only, limited network) and the kind of work's skill. Only the Mac that suggested a task holds its source quotes, so only that Mac drafts it; other Macs skip it and say why. | this Mac | automatic |
| 7. Check | The draft must pass its skill's checklist (headings, citations of real sources). A failed draft goes back to Ready behind the other tasks; after two failures in a row it moves to **Blocked** and shows in Needs you under "Stopped after failed runs", where the PM chooses Try again (back to Ready, count started over), Edit task (opens it in Linear) or Drop (canceled, never deleted); `pmx review --stopped`, `--retry`, `--drop` do the same. What the agent wrote is kept on the local branch `pmx/failed/<task>`, never pushed. | this Mac | automatic, then the PM |
| 8. Review | A passing draft opens a pull request in the team repo (a local branch when the repo has no GitHub remote). A person accepts, rejects or asks for a redo with a note. Accepting a local draft changes only the draft's files and never the PM's own unsaved edits; if the draft changes a file the PM is still editing, PMX names it and waits. | `pmx review` or GitHub | the PM |

Alongside the flow:
- a **weekly digest** of what customers said, which the PM approves before anyone sees it;
- **to-dos** from the PM's own meetings, which never leave the Mac.

### What runs where (this is what "is it running?" means)

| Part | Runs | Set up by | How to see it |
|---|---|---|---|
| **Background job** (launchd `com.productmaxxing.pmx`, `pmx tick`) | every 30 minutes **while the Mac is awake**. Each run updates the team repo, suggests tasks from calls, finds to-dos, starts an agent run on a Ready task, frees tasks an agent stopped working on, and saves the checklist. | `pmx init` (say yes) | `pmx status`; `~/.pmx/logs/tick.log` |
| **Claude app scheduled tasks** | the Claude app starts them every day: meeting collection at 12:30 and 17:30, and on Linear teams the Linear sync every hour. Each run asks PMX first and stops at once outside the PM's working hours (weekdays, the sync 8:00–18:00, by default; `pmx schedule --hours always`, or the page's Schedule buttons, for every day). The hours are PMX's own setting from 0.36.0: changing them needs nothing in the Claude app. They run while the Claude app is open and the Mac is awake. | `/pmx-schedule` in the Claude app | Code tab → Scheduled; `pmx schedule` |
| **Linear sync** ("the relay") | PMX writes to an outbox; the sync task applies it to Linear and copies the project back. PMX sees Linear only as of the last sync. With `pmx linear key` (advanced), PMX writes to Linear directly instead. | `/pmx-schedule` | the checklist's Linear section |
| **PMX's page** | the PM's workspace. It opens on **Needs you**: every decision waiting for them, in the order that unblocks the most (drafts to review first, since the agent waits for them), with who acts and how long each has waited. Then **Work** (the team's tasks by state, agents, the digest), **Health** (status, what's running now and its memory, setup, activity, the flow, Settings) and **My to-dos**. Each setup step PMX can do itself is a button there. It runs in Claude (`/pmx-flow`) or on this Mac (`pmx open`). From 0.36.0 the page in Claude updates itself after a PMX update; the page on this Mac stops by itself after 4 hours unused. | `pmx flow --install-skill`, then `/pmx-flow` | Health → Running |
| **Team board** | the team's Linear project, read through each viewer's own Linear connector | `/pmx-board` | |
| **PMX's server for the Claude app** (`pmx mcp`) | started by the Claude app, so PMX's page in Claude can reach this Mac | `pmx mcp --install` | the checklist's Claude app section |
| **`/pmx-setup`** (this guide) | when the PM asks | `pmx init`, or `pmx checklist --install-skill` | |

**A sleeping Mac runs nothing.** The background job, the Claude tasks and the Linear sync all stop while the Mac sleeps. The checklist reports stretches with no run.

### Where things live

- `~/.pmx`: private to the PM (mode 0700). Settings (`config.json`), state, transcripts, new tasks waiting for the PM, to-dos, run receipts, logs, the checklist history (`checklist.json`). Never synced.
- **The team repo** (`~/pmx` by default): `pmx.config.json` (team settings), `.claude/skills` (each kind of work's instructions), `memory/` (team memory agents read), `CLAUDE.md`, the team package `.pmx/cli/productmaxxing.tgz`, digests, and agents' pull requests. The branch `pmx/runlog` holds the hash-chained run log. It needs a git remote (GitHub) for teammates to share it.
- **The macOS keychain**: tokens (GitHub, optional Linear key, Slack). PMX reads them without showing them.
- `~/.claude`: PMX's commands for the Claude app (`/pmx-schedule`, `/pmx-setup`, `/pmx-flow`, `/pmx-board`), the scheduled tasks, and the always-allow rules for `pmx`.
- **Linear**: one project. PMX tracks status with `pmx-status/*` labels, not Linear's workflow states.

### Team settings and personal settings

**Personal** (`~/.pmx/config.json`, this Mac only): handle, the kinds of work this PM's agent takes, daily cap, transcript folders, the do-not-read lists, and the digest day.

**Team** (`pmx.config.json`, in the repo): Linear project, model, sizes and caps, the review cap, the company's email domains, approved inputs (Slack channels…), the synthesis Mac, the product lead (`productLead`), the brain, and the team minimum version (`cli.min`).

Team changes made from PMX's page open a pull request a teammate approves. A repo with no remote gets a local branch instead, which the PM applies on the page.

### Versions

- **This Mac's pmx**: `pmx --version`.
- **The team package** in the repo: what teammates install with `pmx update`.
- **The team minimum** `cli.min`: a Mac below it keeps its personal work but stops shared work until it updates.

The team lead moves the team to a newer PMX version with `pmx update --latest`, then `pmx vendor --require`, committed in a pull request. With `cli.autoUpdate` on, every Mac installs the team package within the hour.

**What an update does by itself** (on the first pmx command after it; the background job reloads itself only from a command someone runs):
- refreshes PMX's commands in the Claude app, and adds new ones such as `/pmx-setup`;
- points the Claude app's PMX server at the new pmx;
- refreshes the background job with today's Node and Claude Code paths.

**What an update can't do**, because it needs Claude or the PM:
- republish PMX's pages in Claude: from 0.36.0 the workspace page does it itself the next time it's opened, so only a page from before 0.36.0 (once), and the team board when an update changes its page, need it;
- update the scheduled tasks;
- restart the Claude app;
- commit the team package.

`pmx update` prints these at the end (`pmx migrate`), and the checklist lists them under "Still to do after updating" until they're done.

### Money, safety, failures

- **Budget**: a daily cap per PM (Claude Code's estimate at API list prices). On a Claude plan, runs count against plan limits instead.
- **Practice mode**: for the first 7 days after install, the agent only says which task it would take, without running it (`pmx pull --live` runs one now).
- **Kill switch**: a `pmx.stop` file on the repo's main branch stops every agent; a local one stops just this Mac.
- **Failures**: a task that fails twice in a row moves to Blocked with a comment saying why, so it stops holding up the queue. With team features, a kind of work whose last 3 runs, across 2 or more tasks, all failed is paused.
- **The brain** (team features, optional): triages the backlog on one of the team's Macs. It's off unless `pmx.config.json` or the org's admin policy turns it on.

### PMX Engine

PMX Engine (`pmxe`) is a separate tool. The head of product uses it to publish what each audience is told: vision, roadmap, pricing and so on. It feeds PMX's team memory in one direction only, through a reviewed pull request (`/pmxe-memory`).

**PMX is for every PM; PMX Engine is only for the team's product lead.** The team decides who that is, in its settings: `productLead` in `pmx.config.json` (their PMX handle, or `handle@machine`), changed only through a code owner's review like every other team setting (Health → Settings → Account on the page sends it). PMX uses it only to decide whether to offer Engine; it's a convenience, not a permission:

- `pmx install` asks the named product lead "Install PMX Engine too?" (default no; `--yes` never means Engine). Nobody else is asked, ever. Don't offer Engine to anyone else either.
- `pmx install --engine` installs it for anyone, on purpose: a team changing its product lead, say. Only suggest it when the user asks for PMX Engine.
- In the checklist, the product lead without Engine has **Install PMX Engine** (`engine.installed`, todo); everyone else's says it's the product lead's tool (skip). With nobody named, it says the team hasn't named one: only the team names its product lead, so send that to the team lead, as a pull request or the page's setting.
- `pmx update` updates PMX Engine too, where it's installed, with Engine's own updater (`pmxe update`). Engine doesn't update while a release is being sent; PMX says so in one sentence, and PMX's own update still counts.

PMX reads only what `pmxe` prints as versioned JSON (its doctor checks, what's new, checklist and status), never its files, and PMX Engine's workspace denies every `pmx` command. Help with PMX Engine happens in its own workspace, with `pmxe guide`.

On the head of product's Mac, PMX's page has a **Strategy** area: what waits on them, on Claude or on a colleague in PMX Engine, the releases in flight and the pages, read live from Engine, with **Open in the studio**. Their own moves are also last in Needs you, and count in `pmx status`. Approving, signing off and holding happen in the studio, which asks on the Mac.

Rules for you:

- Engine's status is never yours to read through PMX: PMX's MCP tools (`pipeline`, `checklist`, `flow_graph`) don't carry it, and never will. Don't try to get it some other way for a chat; send the user to their page or the studio.
- `pmx checklist --json` adds Engine's own checklist under `engine` on a Mac that has it. Tell the user where Engine stands from it, but do Engine's steps only in PMX Engine's workspace (`/pmxe-setup`) or the studio, never from PMX's setup session.

---

## 2. Rules for you

1. **A person must be at the keyboard.** If a scheduled task started this session, stop.
2. **Auto mode off.** Before installing or changing anything, ask the user to switch auto mode off for this session (Shift+Tab, or the app's mode menu). In auto mode, installing a global npm package, writing the keychain, registering the background job and creating scheduled tasks can be denied without a reason.
3. **Commands only the user runs**, in their own Terminal, because they ask questions, open a browser or read tokens:
   - `pmx init`
   - `pmx claude login`
   - `pmx linear key`
   - anything with a password or token.

   Never type a token or password for them, and never read one back.
4. **Ask before each step that changes this Mac**, then run it if they agree:
   - `npx --yes productmaxxing@latest install` (and its `--yes`, which adds PMX's folder to `~/.zshrc`; `--engine` only for the product lead, or when the user asks for PMX Engine)
   - `npm install -g …`
   - `pmx schedule --allow`
   - `pmx mcp --install`
   - `pmx checklist --fix`
   - `pmx checklist --install-skill`
   - `pmx flow --install-skill`
   - `pmx update`
   - creating scheduled tasks
5. **Team decisions belong to the team lead:**
   - `pmx update --latest`
   - `pmx vendor --require`
   - adding a git remote
   - editing `pmx.config.json`

   Say what they do and who should run them.
6. **Never run `pmx uninstall`.** It deletes `~/.pmx`: settings, to-dos, transcripts, drafts and receipts. Installing over an old version keeps all of them.
7. **Don't move PMX's scheduled tasks to the cloud.** They run `pmx` on this Mac.
8. **Never change Linear on the user's behalf.** No moving tasks, no comments, no labels. Tell them, or the teammate who decides, what to move.
9. **Restarting the Claude app comes last.** Quitting it (⌘Q) ends this session if you're running inside it.

---

## 3. Working through the checklist

`pmx checklist --json` returns:

```
{ format: 1, tool: "pmx", version, at, where, next, sections: [{ id, title, steps: [Step] }], counts, upgrade, engine? }
Step = { id, title, status: done|todo|warn|skip, detail, do?, who?: you|claude|teammate|team-lead, how?: terminal|claude|app|linear|page, required, since?, afterUpdate? }
engine = { format: 1, tool: "pmxe", version, at, where, next: { id, title } | null, sections, counts }: PMX Engine's own checklist, on a Mac that has it, without its commands
```

- `todo` means something is missing. `warn` means it works, but something's off. `skip` means the step doesn't apply on this Mac.
- `required` steps are the ones PMX can't do its job without.
- `next` is the first required step not done, otherwise the first `todo`, otherwise the first `warn`.
- `upgrade.pending` lists what the last update still needs.
- `engine`'s steps are PMX Engine's, not PMX's: they never change `where`, `next` or `counts`. See §1, PMX Engine.
- Each run is recorded in `~/.pmx/checklist.json`, with the date each step was first done. The background job refreshes it on every run.

**The loop:**

1. Run `pmx checklist --json`.
2. **Tell the user where they stand**, in a short paragraph:
   - `where`;
   - what's done, by section ("This Mac ✔, setup ✔, background job ✔ (last run 10:30)…");
   - what's running and what's off ("Linear syncs hourly on weekdays; agents are in practice mode until Nov 27; the brain is off");
   - what's missing, with the next step.

   Use the PM's words, not step IDs.
3. **Do or hand over `next`**, by its `who` and `how`:
   - `who: claude`, `how: claude`: you do it, such as `/pmx-schedule`, `/pmx-flow` or `/pmx-board`. If this session can't use the needed tool (scheduled tasks, artifacts), ask the user to type the command in a new Code-tab session in the Claude app with auto mode off.
   - `who: you`, `how: terminal`: ask the user to run the exact `do` command. If it's on your list in rule 4 and they agree, run it yourself. When the step's `fix.kind` is `pmx`, PMX can do it itself: offer `pmx checklist --fix <step id>` (it asks before changing the background job or the Claude app's settings), or point them to the button on PMX's page.
   - `how: app`: give the exact clicks in `do`, such as Code tab → Scheduled → the task → its last run → Always allow.
   - `who: teammate` or `team-lead`: tell the user who does it and what to send them.
   - `how: page`: in PMX's page (`pmx open`, or the page in Claude).
   - Each open step also has `fix`: `pmx` (a button on PMX's page, `label`; `asks` when PMX asks on the Mac first), `claude` (the slash command in `command`), `person` (a sentence, `text`, and maybe a `link`) or `page` (a place on the page, `to`). The page says exactly that, and never a pmx command.
4. **Run `pmx checklist --json` again** and report what changed, for example "✔ The Claude app runs PMX's scheduled tasks". If the step isn't done, read its new `detail`, check §5, and try once more or explain what blocks it.
5. Repeat until `next` is null or only optional steps (`required: false`) are left. Then summarize:
   - what's set up;
   - what runs, and when;
   - what's left that's optional, and why it might matter;
   - that `/pmx-setup` brings them back here any time.

Don't skip ahead. Don't call something done that the checklist doesn't show as done. Don't bury the user in every step: report the section summaries and the step at hand.

---

## 4. Step reference

**Button** says what PMX's page offers for the step when it's open (SETUP-2): **PMX** is a button that does it (the same as `pmx checklist --fix <step id>`; ⌘ marks one that asks on the Mac first), **Claude** shows the slash command with Copy, **Person** is a sentence and a link, **Page** opens the place on the page.

| Step id | What it means | How it gets done | Button | Notes |
|---|---|---|---|---|
| `os.macos` | macOS | n/a | Person | PMX is macOS-only for now. |
| `mac.node` | Node 22.12+ or 24+ | `brew install node`, reinstall pmx, `pmx init` | Claude (`/pmx-setup`) | Under nvm, removing that Node version breaks the background job. |
| `claude.installed` | Claude Code is installed | https://code.claude.com | Person, with the link | |
| `mac.pmx` | at the team's version | `pmx update`; the team lead uses `pmx update --latest` + `pmx vendor --require` | PMX ⌘ "Update PMX" (below the minimum); Person (the team lead's newer version) | |
| `profile.signed-in` | PMX's own Claude profile is signed in | the user runs `pmx claude login` | Person (`/pmx-setup` shows how) | Without it, every agent run fails with "Not logged in". |
| `setup.config` | PMX is set up | the user runs `pmx init` | Claude (`/pmx-setup`) | It shows a summary and saves nothing until they confirm. |
| `config.team` | team settings readable | fix `pmx.config.json`, or `pmx init` | Claude (`/pmx-setup`) | |
| `setup.remote` | the team repo has a remote | team lead: an empty private GitHub repo, then `git remote add origin <url> && git push -u origin main` | Person (team lead), with a link | Without a remote: no teammates, team changes become local branches, and digests and the run log stay on this Mac. |
| `setup.package` | the team package matches this pmx | team lead: `pmx vendor --require`, committed | PMX ⌘ "Update PMX" (package newer); Person (team lead) | Teammates who run `pmx update` get the package's version. |
| `setup.privacy` | company domains set; test meetings held | `pmx init` adds domains | Page (Who counts as a customer) | |
| `setup.memory` | `memory/product.md` describes the product | fill it in and commit; you can help draft it | Claude (`/pmx-setup`) | Agents draft without context otherwise. |
| `setup.home.private` | PMX's folders are private | `chmod 700` them | PMX "Make them private" | |
| `job.installed` | the background job is registered | `pmx init` (say yes), or the button on PMX's page | PMX ⌘ "Turn on automatic runs" | Before 0.36.0 this step had its doctor check's ID, `schedule.launchd`. |
| `job.paths` | the job finds Node and Claude Code | `pmx checklist --fix` | PMX ⌘ "Refresh the background job" | It breaks when Node or Claude Code move. |
| `job.passes` | PMX's background runs are happening | keep the Mac awake during work hours | PMX "Run now" (no run yet); Claude (failing runs); Person (keep it awake) | A warning shows the stretch with no run. |
| `cli.auto-update` | updates arrive | `pmx update` | PMX ⌘ "Update PMX" | |
| `claude.setup` | `/pmx-setup` is in the Claude app | `pmx checklist --install-skill`, then reopen the app | PMX "Add /pmx-setup" | |
| `claude.allow` | scheduled tasks may run `pmx` without asking | `pmx schedule --allow` | PMX ⌘ "Let PMX's tasks run" | |
| `claude.tasks` | the scheduled tasks exist, are current and ran | `/pmx-schedule`. Then, in the Claude app, open each new task, click Run now, open the run and choose **Always allow** for its connector. | Claude (`/pmx-schedule`); Person (Always allow) | A run waiting on an approval blocks that task's later runs. After the update to 0.36.0, one more `/pmx-schedule`; never again for an hours change. |
| `claude.mcp` | the Claude app reaches this pmx | `pmx mcp --install`, then quit (⌘Q) and reopen the app | PMX "Repair the connection" (⌘ when the app has no entry yet); Person (restart the app) | |
| `claude.page` | PMX's page in Claude is current | `/pmx-flow` (first time: `pmx flow --install-skill`) | Claude (`/pmx-flow`); PMX "Add /pmx-flow" when it's missing | From 0.36.0 the page updates itself after a PMX update; a page from before needs `/pmx-flow` once more. |
| `claude.board` | the team board is current | `/pmx-board` | Claude (`/pmx-board`); PMX "Add /pmx-board" when it's missing | Linear teams only. Needed again only when an update changes the board's page. |
| `linear.connected` | PMX reaches Linear | `/pmx-schedule` creates the sync | Claude (`/pmx-schedule`) | It says how old PMX's copy of Linear is. |
| `linear.hours` | Linear syncs every day | the page's Schedule buttons, or `pmx schedule --hours always` | PMX "Sync whenever PMX runs"; Claude (`/pmx-schedule`, once, for a task from before 0.36.0) | The hours are PMX's own setting from 0.36.0. |
| `work.meetings` | meetings arrive | `/pmx-schedule` (the collection task) | Claude (`/pmx-schedule`) | |
| `work.approve` | new tasks wait for the PM | Start now, Later or Drop each in the page's Needs you, or `pmx proposals start` / `approve` / `drop` | Page (Needs you) | |
| `work.ready` | how tasks become Ready for agents | with Start now on (the default), done: the PM's Start now makes a task Ready, and backlog tasks wait by choice. With `approve.startNow` off: a teammate moves tasks from the backlog to Ready on the team board | Person (a teammate), with the board's link | With Start now off, approving doesn't make a task Ready. |
| `work.practice` | practice mode | wait, or `pmx pull --live` | Person (when real runs start) | |
| `work.agents` | agents can take work, and how the last run went | Blocked after failed runs: in the page's Needs you (Stopped after failed runs), Try again, Edit task or Drop; or `pmx review --stopped`, `--retry <id>`, `--drop <id>` | Page (Needs you; Budget and limits); Person (the team lead's emergency stop) | Try again starts the failed-run count over. |
| `work.brain` | automatic triage | off unless the team turns it on | Claude (`/pmx-setup`) or Page | |
| `engine.installed` | PMX Engine, the product lead's tool | Without Engine: for the team's product lead (`productLead`), a todo, **Install PMX Engine**: `pmx install --engine`, or the button. For anyone else, a skip: "PMX Engine is your product lead's tool." With nobody named: a skip, "Your team hasn't named its product lead." With Engine: done (its version), or "installed at … but didn't start": run `pmxe --version` in Terminal to see why; reinstalling PMX Engine usually fixes it | PMX ⌘ "Install PMX Engine" (the product lead only); Person (Engine didn't start) | Never suggest Engine to someone who isn't the product lead unless they ask. PMX installs it where PMX is installed. PMX runs Engine with its own Node, so a Node only a login shell knows doesn't matter. Engine's own steps are in `engine`, after PMX's: on the page, one done in the studio has "Open in the studio", one Claude does its slash command, a terminal one `/pmxe-setup` in Engine's workspace. |
| `engine.link` | PMX links to the PMs' page in PMX Engine | team lead: `"roadmap": { "url": "<the PMs' page link>" }` in `pmx.config.json`, in a pull request | Person (team lead) | Open only where Engine is installed and the link is missing. |
| `update.*` | what the last update did and still needs | `pmx checklist --fix` for the automatic ones; the rest as listed | PMX "Do it now" (⌘ for the background job) | |

---

## 5. Installing, updating, troubleshooting

### A new install
The order:

1. **Install:** `npx --yes productmaxxing@latest install` (INSTALL.md step 2). It checks the Mac, installs PMX where npm can write without `sudo` (npm's own folder, else `~/.local`), and makes sure a new Terminal window finds `pmx`: from your session it has no terminal to ask in, so when PATH needs a line it prints it and exits 3; ask the user, and on yes run it again with `--yes`. Exit 0 means installed and found. It's safe to run again: on a set-up Mac it changes nothing and says so.
2. The user runs `pmx init` in Terminal. Tell them beforehand what it asks:
   - the team repo (accept `~/pmx`, or give the team's clone);
   - for a new team, the Linear team and project;
   - their handle, kinds of work, daily cap, company email domains, transcript folders and do-not-read lists.

   Tell them to say yes to the background job, to `/pmx-schedule` and `/pmx-setup`, and to the always-allow rules, and to sign in when the browser opens.
3. Then work through the checklist (§3).
4. **The product lead only:** where the team names this user its product lead, the install asked about PMX Engine (or the checklist's Install PMX Engine step does). Engine's own setup is then in its own workspace: `pmxe guide`, `pmxe checklist`, or `/pmxe-setup`.

### An update
1. `pmx update` (or `pmx update --latest` for the team lead). It installs the new version and runs `pmx migrate`, which says what it did and what's left. Where PMX Engine is installed, it then runs Engine's own update, and says in one sentence how that went; a refusal while a release is being sent doesn't undo PMX's update. `pmx update --check` only compares.
2. Work through the checklist. Its "Still to do after updating" list holds each remaining step for the version this Mac came from:
   - From **0.14.0 or older** (Product Git): the first command moves keychain items and the job to the new names.
   - From **before 0.25.1**: quit and reopen the Claude app once, so it starts PMX's new server.
   - From **before 0.35.0**:
     - `/pmx-schedule` (scheduled task descriptions changed);
     - `/pmx-flow` (new page);
     - on weekday-only Linear syncs, consider `pmx schedule --hours always`.
   - From **before 0.36.0**:
     - `/pmx-schedule` once more (the tasks now run every day and ask PMX whether it's inside the PM's hours; changing the hours never needs it again);
     - `/pmx-flow` once more (the page gets the `artifact` capability, and from then on updates itself the next time it's opened after a PMX update).
   - **Any update**: republish PMX's pages if the checklist says they're older (from 0.36.0 the workspace page does it itself; the team board only when its page changed).
3. `pmx whats-new --since <old version>` tells the user what changed. Summarize it in a few lines.

### When "nothing happens"
Check the checklist in this order:

1. `job.passes`: the Mac was asleep, or the job isn't running.
2. `work.practice`: the first week only says what it would take.
3. `work.approve`: new tasks wait for the PM.
4. `work.ready`: nothing is Ready. With Start now on, the PM starts new tasks from Needs you; otherwise a teammate moves tasks there.
5. `linear.connected`: PMX's copy of Linear is old.
6. `work.agents`: tasks are Blocked, or the budget is spent.

### Other common ones
- **"Not logged in" in runs**: `pmx claude login`.
- **A scheduled task never finishes**: its run waits for an approval. Open the run in the Claude app and choose Always allow.
- **Team settings "sent for approval" but nothing changes**: the repo has no remote, so apply the local branch on PMX's page, or add a remote.
- **Drafts fail their checklist**: read the failure comment on the task in Linear. What the agent wrote is on `pmx/failed/<task>` on the Mac that ran it. Once the task is fixed, Try again in Needs you (or `pmx review --retry <id>`).
- **Accepting a draft says there are unsaved edits**: the PM has edits of their own in a file the draft also changes, in the team repo's folder. They save or undo them, then accept again. Their other edits never block it.
- **For details on any one run** (PMX's or an agent's): `pmx explain`.
