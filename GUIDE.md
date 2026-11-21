# The PMX guide for Claude

`pmx guide` prints this file for the pmx installed on this Mac. It's written for **you, Claude**, helping a product manager (PM) install, set up, update or check ProductMaxxing (PMX). Read all of it before you act. Then work from `pmx checklist --json`, which says what's actually done on this Mac. Never work from memory or guesses.

The PM usually doesn't know which parts of PMX exist, which of them run on their own, or what's still missing. Your job is to make that plain at every step: where they stand, what runs, what's next and who does it.

---

## 1. What PMX is

PMX turns a PM's customer meetings into small, sized, cited tasks. Agents draft those tasks (specs, research summaries, competitive notes, prototypes), and the PM reviews the drafts like pull requests. A team shares one PMX setup in a git repo. Each PM runs PMX on their own Mac.

### The flow, and its two human gates

| Stage | What happens | Where | Who |
|---|---|---|---|
| 1. Collect | A Claude app scheduled task saves new meeting transcripts from the PM's meeting app (Granola, Fireflies, Google Meet through Drive…) into `~/.pmx/transcripts`. Nothing leaves the Mac. | Claude app, weekdays 12:30 and 17:30 | automatic |
| 2. Propose | Every 30 minutes the background job applies the **privacy rules** (internal-only meetings, one-on-ones, hiring, pay and more are held back), then asks Claude, with no tools, to propose sized tasks that cite the meetings that passed. | this Mac | automatic |
| 3. **Approve** (privacy gate) | Proposals wait on the Mac until the PM approves or drops each one. **Nothing reaches Linear before approval.** Approved tasks go to Linear carrying only source IDs (`pmx:source T14`), never quotes. | PMX's page (Inbox) or `pmx proposals` | the PM |
| 4. Pool | An approved task lands in the team's **pool** in Linear (label `pmx-status/inbox`). No agent touches the pool. | Linear | |
| 5. **Ready** (work gate) | A teammate moves the tasks worth an agent's time to **Ready** (`pmx-status/ready`) on the team board. This decides what agents spend budget on. | team board (`/pmx-board`) or Linear | a teammate (or the brain, if the team turned it on) |
| 6. Run | Every 30 minutes the background job takes the top Ready task that fits the budget and the review cap. It runs Claude Code headless in a fresh git worktree, with PMX's own clean Claude profile (no personal memory, no connectors, file tools only, limited network) and the kind of work's skill. Only the Mac that proposed a task holds its source quotes, so only that Mac runs it; other Macs skip it and say why. | this Mac | automatic |
| 7. Check | The draft must pass its skill's checklist (headings, citations of real sources). A failed draft goes back to Ready behind the other tasks; after two failures in a row it moves to **Blocked**. What the agent wrote is kept on the local branch `pmx/failed/<task>`, never pushed. | this Mac | automatic |
| 8. Review | A passing draft opens a pull request in the team repo. A person accepts, rejects or asks for a redo with a note. | `pmx review` or GitHub | the PM |

Alongside the flow:
- a **weekly digest** of what customers said, which the PM approves before anyone sees it;
- **to-dos** from the PM's own meetings, which never leave the Mac.

### What runs where (this is what "is it running?" means)

| Part | Runs | Set up by | How to see it |
|---|---|---|---|
| **Background job** (launchd `com.productmaxxing.pmx`, `pmx tick`) | every 30 minutes **while the Mac is awake**. It updates the team repo, synthesizes, finds to-dos, pulls and runs tasks, releases stale ones, and saves the checklist. | `pmx init` (say yes) | `pmx status`; `~/.pmx/logs/tick.log` |
| **Claude app scheduled tasks** | collect meetings on weekdays at 12:30 and 17:30. On Linear teams, the Linear sync runs hourly (weekdays 8:00–18:00, or every day with `pmx schedule --hours always`). They run while the Claude app is open and the Mac is awake. | `/pmx-schedule` in the Claude app | Code tab → Scheduled; `pmx schedule` |
| **Linear sync** ("the relay") | PMX writes to an outbox; the sync task applies it to Linear and copies the project back. PMX sees Linear only as of the last sync. With `pmx linear key` (advanced), PMX writes to Linear directly instead. | `/pmx-schedule` | the checklist's Linear section |
| **PMX's page** | the PM's workspace: what waits for them, what ran, where their data went, settings. It runs in Claude (`/pmx-flow`) or on this Mac (`pmx open`). | `pmx flow --install-skill`, then `/pmx-flow` | |
| **Team board** | the team's Linear project, read through each viewer's own Linear connector | `/pmx-board` | |
| **PMX's server for the Claude app** (`pmx mcp`) | started by the Claude app, so PMX's page in Claude can reach this Mac | `pmx mcp --install` | the checklist's Claude app section |
| **`/pmx-setup`** (this guide) | when the PM asks | `pmx init`, or `pmx checklist --install-skill` | |

**A sleeping Mac runs nothing.** The background job, the Claude tasks and the Linear sync all stop while the Mac sleeps. The checklist reports stretches with no pass.

### Where things live

- `~/.pmx`: private to the PM (mode 0700). Settings (`config.json`), state, transcripts, proposals, to-dos, run receipts, logs, the checklist history (`checklist.json`). Never synced.
- **The team repo** (`~/pmx` by default): `pmx.config.json` (team settings), `.claude/skills` (each kind of work's instructions), `memory/` (team memory agents read), `CLAUDE.md`, the team package `.pmx/cli/productmaxxing.tgz`, digests, and agents' pull requests. The branch `pmx/runlog` holds the hash-chained run log. It needs a git remote (GitHub) for teammates to share it.
- **The macOS keychain**: tokens (GitHub, optional Linear key, Slack). PMX reads them without showing them.
- `~/.claude`: PMX's commands for the Claude app (`/pmx-schedule`, `/pmx-setup`, `/pmx-flow`, `/pmx-board`), the scheduled tasks, and the always-allow rules for `pmx`.
- **Linear**: one project. PMX tracks status with `pmx-status/*` labels, not Linear's workflow states.

### Team settings and personal settings

**Personal** (`~/.pmx/config.json`, this Mac only): handle, the kinds of work this PM's agent takes, daily cap, transcript folders, the do-not-read lists, and the digest day.

**Team** (`pmx.config.json`, in the repo): Linear project, model, sizes and caps, the review cap, the company's email domains, approved inputs (Slack channels…), the synthesis Mac, the brain, and the team minimum version (`cli.min`).

Team changes made from PMX's page open a pull request a teammate approves. A repo with no remote gets a local branch instead, which the PM applies on the page.

### Versions

- **This Mac's pmx**: `pmx --version`.
- **The team package** in the repo: what teammates install with `pmx update`.
- **The team minimum** `cli.min`: a Mac below it keeps its personal work but stops shared work until it updates.

The team lead moves the team to a new release with `pmx update --latest`, then `pmx vendor --require`, committed in a pull request. With `cli.autoUpdate` on, every Mac installs the team package within the hour.

**What an update does by itself** (on the first pmx command after it; the background job reloads itself only from a command someone runs):
- refreshes PMX's commands in the Claude app, and adds new ones such as `/pmx-setup`;
- points the Claude app's PMX server at the new pmx;
- refreshes the background job with today's Node and Claude Code paths.

**What an update can't do**, because it needs Claude or the PM:
- republish PMX's pages in Claude;
- update the scheduled tasks;
- restart the Claude app;
- commit the team package.

`pmx update` prints these at the end (`pmx migrate`), and the checklist lists them under "Still to do after updating" until they're done.

### Money, safety, failures

- **Budget**: a daily cap per PM (Claude Code's estimate at API list prices). On a Claude plan, runs count against plan limits instead.
- **Practice mode**: for the first 7 days after install, the agent only says which task it would take, without running it (`pmx pull --live` runs one now).
- **Kill switch**: a `pmx.stop` file on the repo's main branch stops every agent; a local one stops just this Mac.
- **Failures**: a task that fails twice in a row moves to Blocked with a comment saying why, so it stops holding up the queue. With team features, a kind of work whose last 3 runs, across 2 or more tasks, all failed is paused.
- **The brain** (team features, optional): triages the pool on one of the team's Macs. It's off unless `pmx.config.json` or the org's admin policy turns it on.

### PMX Engine

PMX Engine (`pmxe`) is a separate tool. The head of product uses it to publish what each group is told: vision, roadmap, pricing and so on. It feeds PMX's team memory in one direction only, through a reviewed pull request (`/pmxe-memory`).

PMX reads only PMX Engine's checklist and doctor summaries, never its files, and PMX Engine's workspace denies every `pmx` command. Help with PMX Engine happens in its own workspace, with `pmxe guide`.

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
{ format: 1, tool: "pmx", version, at, where, next, sections: [{ id, title, steps: [Step] }], counts, upgrade }
Step = { id, title, status: done|todo|warn|skip, detail, do?, who?: you|claude|teammate|team-lead, how?: terminal|claude|app|linear|page, required, since?, afterUpdate? }
```

- `todo` means something is missing. `warn` means it works, but something's off. `skip` means the step doesn't apply on this Mac.
- `required` steps are the ones PMX can't do its job without.
- `next` is the first required step not done, otherwise the first `todo`, otherwise the first `warn`.
- `upgrade.pending` lists what the last update still needs.
- Each run is recorded in `~/.pmx/checklist.json`, with the date each step was first done. The background job refreshes it every pass.

**The loop:**

1. Run `pmx checklist --json`.
2. **Tell the user where they stand**, in a short paragraph:
   - `where`;
   - what's done, by section ("This Mac ✔, setup ✔, background job ✔ (last pass 10:30)…");
   - what's running and what's off ("Linear syncs hourly on weekdays; agents are in practice mode until Nov 27; the brain is off");
   - what's missing, with the next step.

   Use the PM's words, not step IDs.
3. **Do or hand over `next`**, by its `who` and `how`:
   - `who: claude`, `how: claude`: you do it, such as `/pmx-schedule`, `/pmx-flow` or `/pmx-board`. If this session can't use the needed tool (scheduled tasks, artifacts), ask the user to type the command in a new Code-tab session in the Claude app with auto mode off.
   - `who: you`, `how: terminal`: ask the user to run the exact `do` command. If it's on your list in rule 4 and they agree, run it yourself.
   - `how: app`: give the exact clicks in `do`, such as Code tab → Scheduled → the task → its last run → Always allow.
   - `who: teammate` or `team-lead`: tell the user who does it and what to send them.
   - `how: page`: in PMX's page (`pmx open`, or the page in Claude).
4. **Run `pmx checklist --json` again** and report what changed, for example "✔ The Claude app runs PMX's scheduled tasks". If the step isn't done, read its new `detail`, check §5, and try once more or explain what blocks it.
5. Repeat until `next` is null or only optional steps (`required: false`) are left. Then summarize:
   - what's set up;
   - what runs, and when;
   - what's left that's optional, and why it might matter;
   - that `/pmx-setup` brings them back here any time.

Don't skip ahead. Don't call something done that the checklist doesn't show as done. Don't bury the user in every step: report the section summaries and the step at hand.

---

## 4. Step reference

| Step id | What it means | How it gets done | Notes |
|---|---|---|---|
| `os.macos` | macOS | n/a | PMX is macOS-only for now. |
| `mac.node` | Node 22.12+ or 24+ | `brew install node`, reinstall pmx, `pmx init` | Under nvm, removing that Node version breaks the background job. |
| `claude.installed` | Claude Code is installed | https://code.claude.com | |
| `mac.pmx` | at the team's version | `pmx update`; the team lead uses `pmx update --latest` + `pmx vendor --require` | |
| `profile.signed-in` | PMX's own Claude profile is signed in | the user runs `pmx claude login` | Without it, every agent run fails with "Not logged in". |
| `setup.config` | PMX is set up | the user runs `pmx init` | It shows a summary and saves nothing until they confirm. |
| `config.team` | team settings readable | fix `pmx.config.json`, or `pmx init` | |
| `setup.remote` | the team repo has a remote | team lead: an empty private GitHub repo, then `git remote add origin <url> && git push -u origin main` | Without a remote: no teammates, team changes become local branches, and digests and the run log stay on this Mac. |
| `setup.package` | the team package matches this pmx | team lead: `pmx vendor --require`, committed | Teammates who run `pmx update` get the package's version. |
| `setup.privacy` | company domains set; test meetings held | `pmx init` adds domains | |
| `setup.memory` | `memory/product.md` describes the product | fill it in and commit; you can help draft it | Agents draft without context otherwise. |
| `job.installed` | the background job is registered | `pmx init` (say yes), or the button on PMX's page | |
| `job.paths` | the job finds Node and Claude Code | `pmx checklist --fix` | It breaks when Node or Claude Code move. |
| `job.passes` | passes are happening | keep the Mac awake during work hours | A warning shows the stretch with no pass. |
| `cli.auto-update` | updates arrive | `pmx update` | |
| `claude.setup` | `/pmx-setup` is in the Claude app | `pmx checklist --install-skill`, then reopen the app | |
| `claude.allow` | scheduled tasks may run `pmx` without asking | `pmx schedule --allow` | |
| `claude.tasks` | the scheduled tasks exist, are current and ran | `/pmx-schedule`. Then, in the Claude app, open each new task, click Run now, open the run and choose **Always allow** for its connector. | A run waiting on an approval blocks that task's later runs. |
| `claude.mcp` | the Claude app reaches this pmx | `pmx mcp --install`, then quit (⌘Q) and reopen the app | |
| `claude.page` | PMX's page in Claude is current | `/pmx-flow` (first time: `pmx flow --install-skill`) | A page keeps the code of the pmx that published it. |
| `claude.board` | the team board is current | `/pmx-board` | Linear teams only. |
| `linear.connected` | PMX reaches Linear | `/pmx-schedule` creates the sync | It says how old PMX's copy of Linear is. |
| `linear.hours` | Linear syncs every day | `pmx schedule --hours always`, then `/pmx-schedule` | |
| `work.meetings` | meetings arrive | `/pmx-schedule` (the collection task) | |
| `work.approve` | proposals wait for the PM | approve or drop them in the page's Inbox, or with `pmx proposals` | |
| `work.ready` | tasks are Ready for agents | a teammate moves tasks from the pool to Ready on the team board | Approving doesn't make a task Ready. |
| `work.practice` | practice mode | wait, or `pmx pull --live` | |
| `work.agents` | agents can take work, and how the last run went | Blocked: fix the task or its skill, then move it back to Ready | |
| `work.brain` | automatic triage | off unless the team turns it on | |
| `engine.*` | PMX Engine summary and the PMs' page link | in PMX Engine's workspace: `/pmxe-setup` | |
| `update.*` | what the last update did and still needs | `pmx checklist --fix` for the automatic ones; the rest as listed | |

---

## 5. Installing, updating, troubleshooting

### A new install
INSTALL.md gets the package onto the Mac. From there:

1. The user runs `pmx init` in Terminal. Tell them beforehand what it asks:
   - the team repo (accept `~/pmx`, or give the team's clone);
   - for a new team, the Linear team and project;
   - their handle, kinds of work, daily cap, company email domains, transcript folders and do-not-read lists.

   Tell them to say yes to the background job, to `/pmx-schedule` and `/pmx-setup`, and to the always-allow rules, and to sign in when the browser opens.
2. Then work through the checklist (§3).

### An update
1. `pmx update` (or `pmx update --latest` for the team lead). It installs the new version and runs `pmx migrate`, which says what it did and what's left.
2. Work through the checklist. Its "Still to do after updating" list holds each remaining step for the version this Mac came from:
   - From **0.14.0 or older** (Product Git): the first command moves keychain items and the job to the new names.
   - From **before 0.25.1**: quit and reopen the Claude app once, so it starts PMX's new server.
   - From **before 0.35.0**:
     - `/pmx-schedule` (scheduled task descriptions changed);
     - `/pmx-flow` (new page);
     - on weekday-only Linear syncs, consider `pmx schedule --hours always`.
   - **Any update**: republish PMX's pages if the checklist says they're older.
3. `pmx whats-new --since <old version>` tells the user what changed. Summarize it in a few lines.

### When "nothing happens"
Check the checklist in this order:

1. `job.passes`: the Mac was asleep, or the job isn't running.
2. `work.practice`: the first week only says what it would take.
3. `work.approve`: proposals wait for the PM.
4. `work.ready`: nothing is Ready; a teammate moves tasks there.
5. `linear.connected`: PMX's copy of Linear is old.
6. `work.agents`: tasks are Blocked, or the budget is spent.

### Other common ones
- **"Not logged in" in runs**: `pmx claude login`.
- **A scheduled task never finishes**: its run waits for an approval. Open the run in the Claude app and choose Always allow.
- **Team settings "sent for approval" but nothing changes**: the repo has no remote, so apply the local branch on PMX's page, or add a remote.
- **Drafts fail their checklist**: read the failure comment on the task in Linear. What the agent wrote is on `pmx/failed/<task>` on the Mac that ran it.
- **For details on any one run**: `pmx explain`.
