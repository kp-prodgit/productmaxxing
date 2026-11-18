# Changelog

Versions follow [semantic versioning](https://semver.org): new features raise the minor number, fixes the patch number, and anything that breaks an older CLI, file or team the major number. See "Updating" in the README.

## 0.32.0: roadmap themes as Linear labels

Bridge 4 of joining PMX and PMX Engine (EQ-38): a task can carry the roadmap theme it serves, as a Linear label, chosen by the PM.

- **Themes come from your team's repo only.** PMX Engine 0.3.7's `/pmxe-memory` adds `memory/engine/themes.json`, through the same reviewed pull request as the strategy: the themes on the PMs' page that every group may see. PMX reads that file at a format it knows and nothing else of Engine's. `pmx doctor` warns about a format it can't read. (OUT-5)
- **Synthesis may suggest one.** When the file lists themes, the model is offered them and may name one per task. A name that isn't on the list is dropped. Teams without the file see no change, and the prompt is as before.
- **The PM decides.** The theme shows on the proposal in `pmx proposals` and in the Workspace inbox, where the PM keeps, changes or clears it (`pmx proposals theme <n> "<theme>"`, or the picker under "Why?").
- **Checked again on approval.** A theme taken off the list since it was suggested is not applied; PMX says so. An approved theme goes in Linear's `pmx-theme` group, created on first use. Through the Claude relay it is a label change the relay task already applies.

## 0.31.0: your team's released strategy, as team memory

Bridge 3 of joining PMX and PMX Engine (EQ-37): agents can draft against what the product managers' page shows, and none of it travels on into the tracker.

- **`memory/engine/` is team memory.** PMX Engine 0.3.6's `/pmxe-memory` puts what the PMs' page shows there, in a pull request that code owners review. PMX never writes to it. (OUT-4)
- **New team repos point agents at it.** The template's `CLAUDE.md` imports `@memory/engine/README.md`, which says what the files are. For a repo set up earlier, `pmx doctor` warns when the folder is there but `CLAUDE.md` doesn't point at it, and gives the line to add.
- **Synthesis never repeats it.** A task whose title or rationale repeats those files eight words in a row is skipped, as one that repeats a meeting already is. Summaries are fine.

## 0.30.0: a link to your team's roadmap

Bridge 1 of joining PMX and PMX Engine (EQ-28): the head of product can give PMs a page of their own in PMX Engine, and every PM's Workspace links to it.

- **A Roadmap link in the nav,** under Team, on this Mac's page and on the page in Claude, when your team's `pmx.config.json` has `"roadmap": { "url": "<link>" }`. The head of product publishes the page from PMX Engine 0.3.5 or later and adds its link in a pull request. PMX holds only the link, never the page's content. (CLI-7)
- **`pmx open roadmap`** opens it from Terminal.
- `roadmap.url` must be a Claude artifact link, like `board.url`.

## 0.29.0: the brain is free on your Macs

Q8: everything that runs on your team's Macs is free, the brain included. What a plan covers is the hosted service: team analytics and cloud leases.

- **The brain needs no license.** It runs on one of your team's Macs, on your own Claude plan. Turn it on with a `brain` block in `pmx.config.json`, in a reviewed pull request, for example `"brain": { "level": "recommend", "machine": null, "everyHours": 4 }`. It has the same fields as the admin policy's brain, and anything left out stays off. A team without the hosted app can use it too. (BRAIN-1)
- **Your org's admin policy still decides when it sets the brain**, "off" included. `pmx brain --status` says which one applies.
- **A license is only for cloud leases.** `pmx doctor` reports a missing license only when the team uses cloud leases, and `pmx status` says none is needed otherwise.
- **`ee/LICENSE` allows it.** From this version, the parts of `ee/` that run on your own machines and use no paid hosted service may be used in production without a subscription: the brain, review caps and auto-pause, and applying the admin policy.

## 0.28.0: one door to PMX Engine

Phase 2 of joining PMX and PMX Engine (Q15, Q16). On a Mac without PMX Engine, which is every PM's, nothing changes.

- **`pmx open`** opens your PMX workspace on this Mac, as `pmx flow --web` does (that still works). Where PMX Engine is installed, the page's nav gains **Studio**, which opens the head of product's studio in its own tab. `pmx open studio` does the same from Terminal. `pmx open --hide-studio` takes the entry away, and `--show-studio` brings it back. The page in Claude never shows it: nothing about Engine goes through the Claude app. (CLI-6)
- **One doctor.** `pmx doctor` adds a line for PMX Engine and each problem `pmxe doctor` found, as warnings that never fail PMX's doctor. (CLI-6)
- **One What's new.** `pmx whats-new` lists Engine's notes you haven't seen after PMX's. (CLI-6)
- **Only versioned output.** PMX reads only `pmxe doctor --json` and `pmxe whats-new --json`, and only at a format it knows (PMX Engine 0.3.4 and later). For an older Engine it says to run `pmxe doctor`. All of it goes through one module, `src/engine/bridge.ts`. A test keeps that module away from Engine's files, and keeps everything that answers a Claude chat away from the module.

## 0.27.0: one look with PMX Engine, and a code on each collected file

- **The team board looks like the rest of PMX.** It now uses the PMX Workspace's colour and type tokens, copied byte for byte, and the Mac's own font instead of IBM Plex from Google Fonts. The board no longer loads a web font. Its lanes keep their colours. PMX Engine's studio copies the same block, so the two products read as one family. A test keeps the board and the Workspace equal. Publish the board again with `/pmx-board` after updating, as after any release. The Digest now says "customer themes". (Q15)
- **Each collection run gives its files a code (COLLECT-3).** `pmx collect --prompt` now issues a code and asks the scheduled task to write it as a `run:` line in every transcript and thread it saves. `pmx collect --check` names any new file without a recent code, so you can tell a file your task saved from one another Claude session put there. This matters on a Mac that also runs PMX Engine, where PMX's always-allow rules reach every Claude session. Nothing changes for your scheduled task: its stored prompt already asks `pmx collect --prompt` for each run's steps. Files without a code are kept and only counted; holding them back comes later, once every task is seen writing the code. Part of the plan to join PMX and PMX Engine as two packages in one family (Q15, Q16).

## 0.26.0: your org and your team define their own kinds of work

A job to be done is now something your org defines, not a fixed list — from a Markdown writer to a prototype builder. (JOB-1..10)

- **Define your team's own kinds of work from a template.** In the board's Settings, **New kind of work** asks what the work is and what it produces, when PMX should propose it (and when not), its stage, the sections every draft has, the steps an agent follows, what the reviewer checks, how many sources it cites, whether it goes outside the team, and what each size means. **Send to your team for approval** opens one pull request on your team's PMX repo with the skill, a sample task, its size row and its config line; when a teammate merges it, every PM on the team has it, and your own agent takes it. From the command line: `pmx jobs template > kind.md`, fill it in, then `pmx jobs new --from kind.md`. Your kinds of work live in your team's repo, never in the PMX package. (JOB-8)
- **Synthesis proposes your kinds of work.** It's told each kind's "propose it when" and "don't propose it when", and it now allows drafts a person then sends or applies, like an update for stakeholders. (JOB-8)
- **Your team can require a kind of work.** From a kind's ··· menu in Settings → Kinds of work, **Require it for everyone on the team** sends a pull request; once merged, every PM's agent takes it and its switch shows Required by your team. Settings → Kinds of work also shows what each kind produces, its stage, when it's proposed, which ones your team made, and a kind whose skill won't run. (JOB-9)
- **Every Mac picks up merged team changes on its own.** The background job fast-forwards your checkout of the team's PMX repo every ten minutes or so, even with automatic updates off, so a new kind of work or setting reaches everyone without a manual pull. It leaves the checkout alone when you're on another branch or have changes to its files, never takes a team config that wouldn't load, and `pmx doctor` warns when a Mac hasn't followed the team for a day. (JOB-10)
- **Editing sizes works for every kind of work.** Sizes for a kind of work with no row in the size rubric used to fail the whole team proposal; the row is now added. (JOB-8)

- **Share jobs through Linear.** `pmx skills sync` reads the skills your team exported from its Linear project and adds them to a per-machine cache (`~/.pmx/org-skills/`), so a teammate who points PMX at the same Linear picks them up. Runs load skills in order **team copy (in the PMX repo) → org (synced) → built-in**. Each synced job shows in `pmx skills` as "org only". _Consume side; the export/publish side lands next._
- **Synced jobs are safe by default (tiered trust).** Only a valid **document** job is adopted and becomes runnable; a job that defines a non-document or tool-widening environment, is invalid, uses the reserved `pmx-` prefix, shadows a built-in, or looks truncated is refused — those must go through a reviewed git PR instead. A refused job never overwrites the copy already cached, and an empty/absent export does nothing.
- **Optional hash allowlist for synced jobs.** Set `skills` in `pmx.config.json` (name → approved hash, reviewed like any config) to require every Linear-synced job to be pinned to its exact content before an agent will run it — a failed or missing pin stops the run, and removing a hash is an instant kill. Left unset, synced document jobs run as-is. Team and built-in skills are never gated. Each run now records which copy of a skill ran (team / synced / built-in) and whether it was pinned.
- **Publish a job to your team.** `pmx skills publish <name>` shares a document job from your PMX repo: the next Linear sync writes it as the document `pmx-skill:<name>`, and that same sync exports every such document for teammates' `pmx skills sync` to pick up — so authoring, publishing and syncing form one loop, all through Linear. Skill bodies live in Linear documents (not issues, which the connector can truncate). Publishing directly with a Linear key or sign-in is coming; today it rides the Claude relay.

- **Jobs can declare an environment.** A category skill's `pmx:` frontmatter may carry an `env` block: its kind (`document` today; `brief` and `prototype` are reserved), the agent's tool allowlist, the output shape (`file`/`repo`/`url`), an optional template and runtime, and a per-run turn cap. Everything defaults to today's document run, so existing jobs are unchanged. Secrets and egress never live in a skill — allowed domains stay in `pmx.config.json`.
- **`pmx jobs new <slug>`** scaffolds a new job: a SKILL.md with its env stub, plus the category added to `pmx.config.json`, for you to fill in, commit and open as a PR. Slugs are kebab-case and can't use the reserved `pmx-` prefix, so your jobs never shadow the built-in skills.
- **`pmx jobs list`** and `pmx skills` now show each job's environment (kind, tools, output), and flag any job whose environment is invalid.
- **Safe by default.** A `document` job may not widen its tools or change its output kind; that needs a non-document environment, which only a reviewed PR can introduce. A run against an unsupported or invalid environment fails closed and returns the task to ready. Distributing jobs through Linear is a later step.

- **Prototype jobs that build, not just write.** A job whose environment is `prototype` now runs: it starts from an optional template, works with a wider tool set, and can hand the heavy build to an external tool (v0, Lovable, Bolt — PMX orchestrates, it doesn't replace them). Its deliverable is a working prototype — a folder of files under `prototypes/…`, or a live preview URL — instead of a Markdown draft, checked by whether it actually produced something runnable. PMX commits it and opens the PR with a run record of what was built. A prototype job must be a reviewed skill in your own repo; an org-synced or built-in skill never gets the wider tools.

## 0.25.1: the board on this Mac shows your settings as they are now

From a report that Settings changes, kinds of work first, didn't take on the board.

- **`pmx flow --web` kept the settings it read when it started**, for as long as it ran (days, since 0.25.0 reopens the board already running). A change made anywhere else didn't show on its page (in the Claude app's /pmx-flow page, with `pmx todo --linear`, or by the collection task adding its folder), and its next save wrote that old copy back over them, so a switch could look like it didn't stick. Its board now reads and saves your settings as they are on disk at each request, as PMX's server in the Claude app always did.
- **The board's controls are tested by clicking them.** New tests load the real page in a simulated browser against PMX's real board server, both as the page on this Mac and as the Claude app shows it. They cover:
  - every switch, dropdown, add box and remove button in Settings;
  - Save, Discard, the review sheet's Undo, Undo after saving, and confirming a change that loosens privacy;
  - leaving Settings with unsaved changes;
  - a team setting going out for approval;
  - New to-do, Mark done and the to-do period;
  - Approve, Drop and its Undo, and Approve all in the Inbox.

  Each save is checked where it lands, in your settings on disk.

## 0.25.0: tasks are proposed on their own, and an empty Inbox says why

SIG-6, SIG-7, TODO-4; APPROVE-1, TODO-1, TODO-3, DIG-2, FLOW-4 and BOARD-3 updated. From a tester's report: a new PM who followed the setup had a working Linear connection, an empty project and a to-do list full of personal items, and nothing said why.

- **Synthesis runs without anyone typing `pmx synthesize`.** It already ran in the background job, but only on the team's synthesis Mac, and no setup step ever chose one, so on a new team it never ran. Now, until the team picks a synthesis Mac, each Mac proposes tasks from the calls it collected (a meeting two PMs saved is still read once, through the team's meeting record). Each run reads from a day before the last one, 7 days the first time and never more than 14, instead of only today's meetings. Synthesis still only proposes: every task waits for your approval.
- **An empty Inbox explains itself.** Instead of "No proposed tasks are waiting", the board, `pmx proposals` and `pmx doctor` say whether synthesis never ran, ran and found nothing, or kept every meeting out, and why: "kept all of them out of tasks: 4 internal-only (no one from outside the company), 1 1:1". The Inbox shows Last synthesis, and on this Mac's page what happened to each recent meeting (not read yet, read for tasks, or kept out and by which rule; a meeting kept out shows its date and rule, never its title).
- **Run synthesis from the board.** The Inbox has Run synthesis now, with a rough cost, when meetings are waiting to be read.
- **To-dos and tasks, told apart.** Today, Anytime, the Inbox, the to-do details and the Connect screen say that to-dos come from all your meetings and never leave this Mac, and that tasks come only from customer calls and go to Linear after you approve them.
- **`pmx doctor` warns** (`synth.never`) when Linear is connected and meetings were collected but this Mac never proposed a task.
- **Your own commitments in Linear, if you want.** Off by default. Turn it on in Settings, under What Linear gets, or with `pmx todo --linear on`; each to-do then has Send to Linear (`pmx todo linear <id>`). Only the to-do's words go, as a `commitment` no agent picks up.
- **Fixes:**
  - `pmx digest --review` with no terminal deleted the staged digest. It now keeps it: nothing is published or deleted without an answer.
  - `pmx todo --refresh` read only today's meetings. It now reads the last 7 days', skipping meetings already read.
- **Pick the period for `pmx todo`.** `pmx todo` lists to-dos from the last 7 days' meetings by default, and says how many open ones are older and the `--days` that shows them. `--days 30`, `--since 14d`, `--since today` or `--since 2026-11-01` pick another period, up to 90 days; `--days all` lists every to-do. The same options set how far back `--refresh` reads. On the board, Today, Upcoming and Anytime have a "From meetings in" picker (Today, 7, 14, 30 or 90 days, or All time; the last 7 days by default, remembered in that browser), and say how many to-dos from earlier meetings it hides, and how many of those are due, with a button that shows them.
  - `pmx flow --web` started a new server and link each time, so old links said the link had expired. A second run now opens the board already running; one left from an older pmx is stopped first.
  - The page's Connect button said nothing useful when the Claude app still ran an older PMX server. It now says to quit the Claude app (⌘Q) and open it again.

## 0.24.1: the Flow map is back, and PMX's server in Claude follows updates

FLOW-4, FLOW-5, BOARD-1, BOARD-3.

- **Flow is back in the left menu.** The map from 0.16.0 to 0.22.0 is its own place again, under System: every step from your sources through the privacy filter, Claude, your approval and Linear to the agents and review, with arrows coloured by what they carry, counts of what moved in the window, and a panel saying what each step and arrow does and which settings shape it. Map or List, keyboard navigation (arrow keys, `[` and `]`), and a dot that runs along an arrow when something new moves. Nothing else changed: Status keeps its list of the steps, and old `#flow` links open the map.
- **PMX's server in the Claude app switches to a new pmx by itself.** The Claude app starts `pmx mcp` once and keeps it running, so after an update your page in Claude kept talking to the old code, and could break as it loaded half of the new one. Now, before each message, the server checks the pmx installed on disk; when it changed, it starts the new server and passes everything to it, and tells the Claude app the tools may have changed.
- **Servers from 0.24.0 or older need one restart of the Claude app.** They can't switch by themselves. `pmx update`, the first `pmx` command after an npm install, `pmx whats-new` and `pmx doctor` (`flow.mcp-old`) say when one is still running: quit the Claude app completely (⌘Q) and open it again. The page in Claude says so too when the server answering it is older than the page. `INSTALL.md` now has this step.

- **Pages in Claude no longer fall behind silently.** PMX can't publish artifacts, so a page published with `/pmx-flow` or `/pmx-board` kept the old code after an update until someone typed the command again, and nothing said so. Now, however pmx was updated (`pmx update`, the background auto-update or `npm install -g`), PMX tells Claude and you:
  - **The update's output.** `pmx update` and the first `pmx` command after an npm install name each page published with an older pmx, and tell Claude, when Claude ran the update, to publish it again now with the `pmx-flow` or `pmx-board` skill, keeping its link. `pmx whats-new --json` lists them as `pagesToUpdate`.
  - **Claude in the Claude app.** PMX's server (`pmx mcp`) tells Claude about the out-of-date page when the app starts it, so Claude offers to update it, and the `pipeline` tool lists it among the problems.
  - **The page itself.** Your workspace shows "published with pmx X, this Mac now runs Y: type /pmx-flow", with the command to copy. This works on pages published with 0.23.0 and later.
  - **The scheduled collection** ends its report with the same line. It never publishes pages itself.
  - **The auto-update notification** and **`pmx doctor`** say which command to type.
- `INSTALL.md` now tells Claude to publish the pages again after an upgrade.

## 0.24.0: Fireflies, read through its Claude connector

COLLECT-1, INPUT-1.

- **Fireflies has its own recipe.** PMX already tried Fireflies among the meeting apps, but only with general steps. The collection task now uses Fireflies' connector the way it's built: it lists your meetings since the last run with `fireflies_get_transcripts` (only the ones you attended, unless it's the team's run), fetches each transcript with `fireflies_get_transcript`, drops the `[00:05 - 00:08]` timestamps, joins one speaker's lines into turns, and leaves out Fireflies' own notetaker. A meeting still live or not yet transcribed waits for a later run.
- **Never Fireflies' summaries or write tools.** The task is told never to use Fireflies' AI summary tools (`fireflies_get_summary`, `fireflies_fetch`, `fireflies_search`) and never the ones that share, rename, move, upload or create meetings or soundbites.
- **Timestamps are cleaned on check.** If any recorder's lines still start with a timestamp, `pmx collect --check` removes it, so a time never ends up quoted in a task.
- To read Fireflies on every run, alongside the first meeting app connected, add it: `pmx sources add Fireflies`. Connect it in the Claude app under Settings → Connectors.

## 0.23.0: a workspace you work in, right inside Claude

BOARD-6; FLOW-4, FLOW-5, BOARD-3 and PRIV-7 updated. After a multi-agent review found the board hard to act on, and the Claude page unable to act without a server in Terminal.

- **A SaaS-style workspace.** A left menu replaces the tabs. Your work comes first, in lists like Things: **Inbox** (tasks to approve, with why and where they were heard; the weekly digest; team changes; anything that needs a fix), **Today** (drafts to review, to-dos due, This Evening), **Upcoming** (dated to-dos and PMX's next runs), **Anytime** (to-dos with no date, by meeting, and Someday) and **Logbook** (what you finished, approved, dropped or decided in the last 14 days). Then **Plan**, **Digest**, **Agents** and **Status** (health, privacy checks, the flow and activity).
- **Settings in its own screen**: grouped sections (Sources, customers, do-not-read, always private, what Linear gets, schedule, digest, kinds of work, budget, account), cards with toggles, and Save Changes with a review of every change. Team changes still open one pull request, and a change that lets more through still asks first.
- **Undo.** Approving, dropping or ticking off waits a few seconds, with Undo, before it happens.
- **Your own to-dos.** Add one (the + button or `n`; "tomorrow", "Friday", "tonight" and "someday" work), and move any to-do to Today, This Evening, Someday or a date.
- **Keyboard**: 1–5 for the lists, j/k to move, Space to complete or approve, a/d to approve or drop, n for a new to-do, / to search, ? for all shortcuts.
- **The Claude page acts, with no Terminal.** `/pmx-flow` publishes the same workspace. Click Connect once: PMX asks you on your Mac, in a dialog, whether to allow the page. After that the page shows your tasks, to-dos and digest and acts on them, through the server the Claude app starts on its own (`pmx mcp`). Titles reach only your page, uncached; a Claude chat can't read them or act without a key you allowed on the Mac. Disconnect with `pmx mcp --unpair` or Settings → Account. Type /pmx-flow in the Claude app to update a page you published before; `pmx doctor` reminds you.
- **Safer writes.** PMX's to-do and proposal files take a lock, so the background job and the page never overwrite each other's changes.

## 0.22.0: Google Meet's notetaker as an input, and links point to productmaxxing.ai

INPUT-1.

- **Google Meet's notetaker.** When someone in a Google Meet uses Gemini's "Take notes for me" or turns on transcripts, Meet saves Google Docs in Drive. PMX now reads them through your Google Drive connector: it finds each meeting's "Notes by Gemini" or "Transcript" doc and copies the transcript word for word. Gemini's summary and next steps are AI notes, not what people said, so a meeting with only those is skipped (it's counted as "no transcript"; turn on transcripts in Meet to have it read). Add it with `pmx sources add "Google Meet"` or the board's Sources tab; it says it's read through Google Drive and, if Drive isn't connected, asks you to connect Drive.
- **A meeting app you add is read every time.** The built-in meeting apps (Granola, Fireflies, Otter, Fathom, tl;dv, Zoom, Google Meet) are still tried in order, using the first one connected. Add one as a recorder and it's read on every run alongside that one, so Google Meet calls come in even when you also use Granola. A meeting both saved is read once.
- **Links point to productmaxxing.ai**: the docs link in `pmx --help`, the Claude plugin's homepage, the README of a new team repo, and the cloud addresses `pmx login` and `pmx cloud` use (api.productmaxxing.ai, app.productmaxxing.ai). Email addresses are unchanged.

## 0.21.1: the npm page links to productmaxxing.ai

- **The package's homepage is now https://productmaxxing.ai**, so the Homepage link on npm goes to the site. Nothing else changed.

## 0.21.0: any Claude connector feeds PMX, with no duplicate tasks

INPUT-1, INPUT-2. Slack through the Claude connector instead of a token, a recorder like Momentum, and one pattern for every other connector.

- **One pattern for every connector.** PMX still never connects to anything. The collection task in your Claude app reads each source through your own connector, following instructions PMX writes for every run, and saves what it reads word for word. A source is either **calls** (recorded conversations: Granola, Momentum, Gong…) or **channels** (conversations in places: Slack or Teams channels, a support inbox). Name the connector as Claude shows it and PMX does the rest.
- **Sources tab.** Where PMX listens, whether each source is connected in Claude and what it read this week, with the same four steps for every source. Add a recorder (just you) with an optional "only read…" note; add channels and pick the Mac that reads them (your team approves, as one proposal). A source that isn't connected in Claude says so, on Sources and on Today.
- **Slack through your connector.** Team channels are listed in `pmx.config.json` as `inputs` (Slack channels approved the old way still count, and move into `inputs` the first time someone changes them on the board). Only the team's synthesis Mac reads them, one file per thread, never DMs or group DMs, and private channels only if your team allows them. `pmx collect --check` deletes any thread from a place that isn't approved. `pmx init` no longer asks for a Slack token to read channels; a token is only for the optional digest DM.
- **Recorders of your own.** `pmx sources add Momentum --only "calls tagged Discovery"`, or the Sources tab. Every recorder you add is collected each run, alongside the first built-in meeting app that's connected.
- **No duplicate meetings.** Two recorders rarely agree on a meeting's title, so PMX also recognizes a meeting by who was there and when it started (give or take 20 minutes), and keeps the fullest copy. To-dos, digests and team tasks all read it once.
- **No duplicate tasks.** Each run makes one task per need, citing every call and thread that raised it. Claude sees what's open in Linear and waiting for you, and says when a need is the same; PMX checks near-identical titles too. A repeat adds its sources to the waiting proposal ("Heard again in 2 more sources") or is recorded as heard again for the open task, on your Mac only.

## 0.20.0: the board is your PMX home

BOARD-5. The pipeline board, rebuilt around a PM's day after four reviewers (a first-time PM, a daily user, a head of product and a designer) went through it, and checked again by three more.

- **Today first.** One status sentence says what needs you. Below it: setup steps with a button each, tasks to approve, drafts to review, your digest, and your to-dos (tick them done on the page). Beside them: this week's numbers, which automations need a look, and whether your privacy is intact. A "What happened" feed lists the week in counts and task IDs.
- **Digest tab.** The weekly digest had no UI. Now it has a reader with citations that jump to their source, Edit, Approve and share (a pull request in your team's repo, and your Slack DMs if set) and Reject, the next build date, past weeks and how each ended, and a Build it now button. Its day and Slack member ID are settings on the board.
- **Automations tab.** Every interaction point, automated or not, as one status row: collection, to-dos, task proposals, your approvals, the Linear sync, the digest, agent pick-up, your reviews, auto-pause, freeing stuck tasks, the company roll-up, automatic runs, updates, analytics and team settings in review. Each says what it's for, who does it, when it last ran and what came of it, when it runs next and how it's doing. Steps this Mac can run have Run now; Turn on automatic runs registers the background job without Terminal.
- **Agent work, Privacy, Settings.** Categories and skills are one tab, with each kind of work's quality (accept rate against the pause bar) and a switch for whether your agent takes it; ids and file paths sit behind Details. Rules is split into Privacy (checks, sources, customers, do-not-read, always private, what Linear gets) and Settings (just you, then your team). Team changes are worded as a proposal a teammate approves.
- **Product words, not commands.** Problems say what's wrong and offer a button; Terminal commands sit behind "Prefer Terminal?". The Linear sync warning no longer names pmx commands. The map hides zero counts and its legend folds away. Old links (#rules, #categories, #schedules, #skills) land on their new tab.
- **Fixes.** Reviewing a teammate's draft from the board no longer says it isn't waiting (the board now loads every draft in review, as `pmx review --all` does). Team copies of skills written before stages group by their known stage instead of "Other".

## 0.19.0: categories follow the product's life, from problem to production

CAT-2 to CAT-5. The categories now follow one product philosophy: fall in love with the problem, build the real thing, and count only paid commitments as validation.

- **Four new categories.** `problem-brief` (who has the pain, what it costs them, what they've asked for and whether they'd pay), `build-brief` (the smallest working product someone would pay for, ending in a prompt for Claude Code), `validation-plan` (who is asked to pay, for what, the buyer's procurement path, and kill criteria) and `validation-readout` (commitments by rung, blockers, what changed and the decision). Each has its skill, required sections, minimum citations, size rubric row and a test fixture.
- **New teams get eight categories.** `pmx init` writes all of them to a new team's `pmx.config.json`. Existing teams keep theirs; to add one, add its line to `categories` (the skills are built in) and its row to a team copy of the size rubric, in one pull request.
- **Shared drafting rules.** Every product category skill now says: problem first; what users ask for is a signal, not the requirement; cite or mark *Assumption:*; only payment or a formal commitment validates; decisions are options marked **PM decides**; no unsourced numbers; end in a decision.
- **Upgraded skills.** Research synthesis adds **Insights** (themes the team can act on, each naming its decision). Competitive analysis adds **Switching bar** and counts the customer's current workaround as an alternative. Spec adds **Validated by**. Teams with their own copy of these skills keep their copy; `pmx skills` shows it differs from the built-in.
- **Lifecycle stages.** A category skill's `pmx:` line can name its `stage` (identify, build, validate, productionize, operate). The board's Categories tab groups categories by stage, and the pipeline data gains `stage` on each category.
- **Claude chooses a category by its description.** Synthesis and the company roll-up now list each category with its skill's description, not the id alone.

## 0.18.0: a Categories tab shows each kind of work end to end

CAT-1. Categories are how PMX grows, so the board now shows each one from task to review in one place.

- **Categories tab.** One card per category in `pmx.config.json`, read left to right: the Linear label (`pmx-category: <id>`) with how many tasks are proposed, in Inbox, Ready, being drafted, waiting for review, done or rejected; the skill Claude follows, whether it's the team's copy, and its runs in the window; the draft file (`outputs/<category>/<task ID>.md`), its required sections and minimum citations, from the skill's `pmx:` line; and the accept rate over the auto-pause window, with when agents stop taking the category. Each size's wording from the rubric sits underneath. A category's name is its skill description's first sentence.
- **What's wrong, in place.** A paused category says why. A category whose skill is missing says agents can't draft it. Linear tasks in a category no skill handles are listed, since agents skip them.
- **Add a category.** The three files a new category needs: its skill, its `pmx.config.json` entry and its size rubric row, in one pull request. Claude chooses a category for a proposed task by its name alone, so the name has to say what the work is.
- **Links.** `#categories/<id>` opens one category; skill cards link to their category and back; the Ready, Agent works, To review and Done steps link to the categories.
- The pipeline data gains `categories` and `unknownCategories`, counts and config only, so the board published in Claude shows them too. `skillInventory` carries each category skill's checklist.

## 0.17.0: the pipeline board shows you where to act

From a usability review of the board by four critic agents (actions, map and navigation, clarity, accessibility and states). BOARD-4.

- **The map is clickable where you can see it.** The selected step's detail sits beside the map from 1180px wide, and scrolls into view below it on narrower windows, with a way back. The selected step is outlined and its connections stay lit while the rest dims; steps and arrows show hover and focus. The map is one Tab stop: arrow keys move between steps, Enter opens one, `[` and `]` walk its connections.
- **Numbers mean one thing each.** Arrows count what moved in the window; a dark pill on a step counts what's waiting there now (to approve, to review, to-dos, Ready). A key above the map says so, and connection lines differ in pattern as well as colour.
- **A one-line summary and a needs bar that goes to the action.** "Last 7 days: 2 meetings collected, 1 kept private, …". The cards open the step and focus its first action; empty ones say so quietly. Open to-dos get a card and are listed on this Mac's page.
- **Problems say how to fix them.** Each has a command to copy and, where the board can fix it, a button to the setting. A failed privacy check is the first problem, not a line at the bottom; checks read in plain words ("Test meetings were kept private", "Agent history is untouched").
- **Actions on the board.** Approve shows "Sending…" and can't be clicked twice; "Approve all"; Drop waits six seconds with Undo. Agent drafts can be accepted, rejected or sent back for a redo with a note (`POST /api/pipeline/review`), with a link to the task in Linear.
- **Settings changes you can trust.** Apply can't be clicked twice and stays disabled until you confirm a loosening. If the team pull request fails, the board says your own changes were saved and keeps the team edits to try again. The pull request is a link, open ones show as "in review" on the team's rules, and Undo puts your own settings back.
- **Nothing you're doing is lost on refresh.** The minute refresh leaves the detail panel and the Rules tab alone unless something in them changed, keeps open sections open and keeps text you were typing.
- **Links and reloads work.** Tabs and steps have addresses (`#rules/dnr`, `#connections/approve`), Back works on this Mac's page, and reloading keeps working; an expired link says to run `pmx flow --web` again.
- **The shared board in Claude is honest about what it can do.** Your own settings change there and become commands to copy; team settings show as text; adding to the do-not-read list says so next to the form. Type `/pmx-flow` again to update a board you published.
- **Clearer words.** "Kept private" instead of held, "proposed task" before approval and "agent draft" after, labels that say where data sits ("On your Mac", "Sent to Claude", "In Linear"), and scope tags "Just you", "Whole team, needs review", "Built in".
- **Accessibility.** Selection and results are announced, errors alert once, focus is visible in the tray and segmented buttons, paused updates aren't shown as an error, and light-theme faint text meets contrast.

## 0.16.2: the board's Skills tab lists your skills again

- **Fixed: the Skills tab on the pipeline board** (`pmx flow --web` and `/pmx-flow` in Claude) showed "[object HTMLDivElement]" instead of the skills. It now lists them in their three groups with run counts. A test checks the page for the same mistake. Type `/pmx-flow` in the Claude app again to update a board you published there.

## 0.16.1: setup connects the board in Claude

- **`pmx init` offers PMX's local server to the Claude desktop app** (FLOW-4), so the `/pmx-flow` board reads PMX without a separate `pmx mcp --install`. It asks first, because it changes the Claude app's settings, and only when the app is on the Mac. The server answers with counts only, never meeting or task titles; its one write adds to your do-not-read list. Restart the Claude app once afterwards.
- **A Mac that said yes before stays current.** Running `pmx init` again updates the registered server to this pmx without asking.
- **A stable Node path.** The server is registered with Homebrew's stable Node path, like the background job, so `brew upgrade node` doesn't stop it. `pmx doctor` warns when the registered Node or pmx no longer exists, or is a versioned Homebrew folder.

## 0.16.0: the pipeline board

The flow view is replaced by a board built from five critic agents' reviews of a prototype.

- **`pmx flow --web` is the pipeline board (BOARD-3).** Four tabs:
  - Skills: what each does, which step uses it, how often it ran.
  - Scheduled tasks: today's run times, last and next run, and whether each ran on time.
  - Connections: a map from your meeting apps and Slack, through the privacy filter, Claude and your approval, into Linear and on to agent work, with a count on every connection. Colours say what travels: full text on this Mac, redacted text to Claude, summaries to Linear, or nothing. Click any step or connection for what it carries and the rules that govern it. A list view replaces the map on a phone.
  - Rules: what each source may feed, who counts as a customer, what's always held, your never-read list, what Linear gets, t-shirt sizes, budget and your agent's work.
- **"Needs you" first.** Proposed tasks to approve (approve or drop them right there), drafts to review, and anything that didn't run on time.
- **Change rules from the board.** Your own settings apply on this Mac at once. Team settings (company domains, sizes, the size rubric, the review cap) become one pull request to the PMX repo. Anything that lets more of your meetings through asks you to confirm.
- **Live, honestly.** The board refreshes every minute and moves only when a batch of work landed (collection, the background job, the Linear sync), with "updated at" and "since you opened".
- **`/pmx-flow` publishes the same board** as a Claude artifact. It shows counts only (no meeting or proposal titles, no do-not-read entries) and can only add to your never-read list.
- **New commands:** `pmx sources set <source> off|mine|linear` (a source can feed nothing, only your to-dos, or to-dos and team tasks; collection skips connectors you turn off), `pmx domains add|remove`, `pmx categories add|remove`, `pmx never-ingest remove`.
- **Privacy (PRIV-7).**
  - Nothing about meetings goes to Linear any more. The record of processed meetings moves to your PMX repo (`refs/pmx/meetings`), so it no longer reaches Linear before you approve anything. Markers older versions put in Linear still count, and `pmx linear withdraw` cancels them.
  - Meeting IDs are keyed with your PMX repo, so someone who can see the record but not the repo can't confirm a meeting happened by hashing a guessed date, title and attendee list. Older IDs still match.
  - The shared view (the Claude artifact) shows no meeting titles and no titles of tasks you haven't approved.

## 0.15.0: Product Git is now ProductMaxxing

- **New name.** The public repo is `kp-prodgit/productmaxxing`, the npm package is `productmaxxing` and the site is productmaxxing.com. The `pmx` command, `~/.pmx`, your PMX repo, your settings and your data don't change. Old GitHub links redirect.
- **Existing Macs move over by themselves (RENAME-1).** npm won't install a differently named package over the old one's `pmx` command, so each release and your team's PMX repo also carry a bridge: the same build packed under the old name `productgit`, at the old file names (`productgit-0.15.0.tgz`, `.pmx/cli/productgit.tgz`). A Mac on 0.14.0 or older updates to it as usual. On its first run the bridge:
  - moves PMX's keychain items from the `productgit` service to `productmaxxing`, deleting each old copy only once the new one reads back;
  - replaces the `productgit` npm package with `productmaxxing`, putting the bridge back if that install fails, so the Mac always keeps a working `pmx`;
  - hands the command it was running to the new `pmx`, which re-registers the background job as `com.productmaxxing.pmx` with the same Claude Code and stops the old `com.productgit.pmx` job.
- **`pmx doctor`** warns while anything is still under the old names, and `pmx uninstall` removes those too.
- **Installing by hand over Product Git:** run `npm uninstall -g productgit` just before installing (README, "Updating"; INSTALL.md). The release's SHA256SUMS lists both packages, so check it with `shasum -a 256 -c SHA256SUMS --ignore-missing`.

## 0.14.0: private meetings stay private, and you approve what reaches Linear

From a tester's first real run: internal 1:1s and a hiring interview were treated as customer calls, task issues carried raw transcript text, every processed meeting showed up in Linear under its own title, a $0 budget paused some commands but not others, and the board stayed empty.

- **Company domain, or nothing (B2).** A call counts as a customer call only when someone outside your company's email domains attended. PMX now adds your own work domain to the team's `internalDomains`, and `pmx init` asks for it. With no domain known, PMX holds every meeting instead of treating colleagues as outsiders, and `pmx doctor` fails. Before, an empty `internalDomains` made every attendee look external.
- **More meetings held whole.** A title about 1:1s, hiring or interviews, performance, pay or health holds the whole meeting from team tasks, as does a two-person meeting whose title names two people ("Sam / Priya"). A meeting that returns to one of those topics in two or more passages is held whole too; one passage is still just cut. Hiring and interviews are a new topic; "customer interview" and other research interviews are not held. Your own to-dos still read 1:1s.
- **You approve every task before it reaches Linear (APPROVE-1).** `pmx synthesize` and the background job now stage proposed tasks on your Mac. `pmx proposals` shows each one exactly as Linear would get it, plus, for you only, which meetings it came from and why. `pmx proposals approve 1 3` (or `--all`) sends them to the PMX inbox; `drop` discards them.
- **Summaries, never transcripts (PRIV-6).** A task's description is a short summary in the model's words, its size reasoning, and how many sources it has and when they were. No excerpts, titles, speaker labels or quotes. PMX adds these rules to every synthesis prompt, even when your team's copy of the skill is older. It refuses a description that repeats eight words in a row from a meeting, and drops any cited source the model can't say supports the task. A task with one source says so.
- **Processed meetings are opaque in Linear.** The marker that stops two teammates processing the same meeting is now titled "Processed meeting m1a2b3c4d", with only the date and who processed it.
- **Take back what older versions wrote (TIDY-1).** `pmx linear written` lists every issue PMX wrote and flags old ones. `pmx linear tidy` rewrites task descriptions without meeting excerpts and gives markers opaque titles. `pmx linear withdraw PMX-12` moves an issue to canceled and replaces its text. Each asks first, and nothing is deleted. Linear may keep earlier text in an issue's history.
- **A dollar cap is optional (BUDGET-1).** On a Claude plan the dollars are Claude Code's estimate at API list prices, not a bill, so `pmx init` sets no cap of your own; your team's cap still applies. On an API key, Bedrock or Vertex it still asks. `pmx status` and the new `pmx budget` show tokens first and say what the dollars mean. `pmx budget set 10`, `pmx budget off` and `pmx budget set 0` (pause) change it without editing files.
- **One budget check for every run (BUDGET-2).** To-dos, the digest, synthesis, the company roll-up, the brain and pulls all stop the same way at a $0 or used-up cap, before any meeting is claimed. Before, `pmx todo` and `pmx synthesize` ran anyway, and the digest wasn't counted at all. `pmx doctor` warns, `pmx status` says "PAUSED", and the background job reports it once per pass instead of as a failure.
- **The board explains itself (BOARD-2).** Every Linear sync makes sure PMX's labels exist, and `pmx doctor` names missing ones. An empty board says why: no PMX labels yet, or no approved tasks yet.
- **Setup fixes.**
  - A Linear link pasted as the team key or project ID now works: PMX keeps the key or the project's slug, in `pmx init` and in existing configs, and the sync check treats a link and its slug as the same project.
  - The sync records its real time: PMX stamps it from the snapshot file, instead of trusting a time the model may not know.
  - The background job uses Homebrew's stable Node link (`…/opt/node/bin/node`), so `brew upgrade node` doesn't break it. `pmx doctor` fails when the job's Node or Claude Code path no longer exists, and warns on a versioned one; run `pmx init` again to fix either.
  - `pmx schedule` and `/pmx-schedule` update a scheduled task whose description is stale, not only its prompt.
  - `pmx todo --refresh` says how to read earlier meetings when it finds none today.

## 0.13.0: no more working hours

- **PMX works whenever this Mac is on and awake.** Your daily spend cap still limits it, along with the review cap. Pulls no longer stop "outside your working hours".
- **`pmx init` stops asking for working days and hours.** Its summary shows the spend cap instead. Hours saved by an older `pmx init` are ignored, so existing machines need nothing. Init still writes "always" to the old field, so an older pmx reading the same config behaves the same.
- **README: updating existing machines.** A table says what to do on each kind of Mac (auto-update, `pmx update`, `pmx update --latest`, or a one-time manual install for versions older than 0.10.0), with the manual install commands. A test keeps the README's install links on the current release; they had fallen behind at 0.10.0.

## 0.12.0: PMX tells you what's new

Every release now tells existing users, and the Claude Code session running the update, what changed (NEW-1).

- **Once, after any update.** The first `pmx` command after an update prints what's new since the version this Mac had. It prints to stderr, so `--json` output stays clean. It covers every release in between, and shows only once. The background job, `pmx mcp` and `pmx uninstall` never print it.
- **`pmx update` and `pmx update --latest`** print the new version's notes as soon as they install, so whoever ran the update sees them right away, including Claude Code.
- **The auto-update notification** names the new release's headline.
- **`pmx whats-new`** shows this version's notes again. `--since <version>` covers everything after one, `--all` lists every release, and `--json` is for Claude and scripts.
- **Manual installs too.** After installing over a pmx older than 0.12.0 by hand (INSTALL.md), PMX covers the releases since this Mac was set up, up to three. A fresh install starts up to date.
- **Every release ships notes.** The notes are a list inside PMX, newest first. A test fails the build when this version has no entry or CHANGELOG.md has no matching section, so no feature reaches users unannounced.
- INSTALL.md's upgrade steps now have Claude run `pmx whats-new --since <old version>` and tell the user.

## 0.11.0: see where your data went

A flow view of everything PMX does, built from records it keeps. The goal is that you can check, rather than trust, that no confidential meeting reached Linear.

- **`pmx flow --web` (FLOW-1, FLOW-2).** A page on this Mac with six columns:
  - Arrivals: meetings and Slack threads, with their connector.
  - Checkpoint: what your rules held, and why.
  - Workshop: the runs, with the skill and version each used.
  - Tasks: proposed tasks, with size and reason.
  - Linear: the issues they became, and the meeting ledger.
  - Departures: agent runs, review verdicts, time and cost.

  The page also has:
  - **Trace:** click anything to light its path both ways.
  - **Lenses:** recolor by privacy, skills, cost or time.
  - **Run filter:** pick one run to see only its path.
  - **3D days:** stacks each day as a layer; turn the stack and pick a day.
  - **Spend:** shown against your daily cap, in USD. PMX can't read your Claude plan's usage.
  - **Held meetings:** shown by the file and title found again in your folders, on your screen only.

  `pmx flow` prints the same claims in Terminal.
- **The audit and its seal (FLOW-3).** "N held · 0 reached Linear", backed by checks you can open:
  - every held meeting's identity is compared against Linear's meeting ledger;
  - every task cites only sources that passed;
  - nothing queued for Linear carries a canary;
  - the run log's hash chain is intact.
- **Canaries (FLOW-3).** Every run tests fake confidential meetings against its own rules in memory: a 1:1, an internal-only meeting, pay, performance and health passages, and your own do-not-read entries. Each run records the result. `pmx doctor` fails if one gets through. Both Linear paths refuse anything carrying a canary.
- **A live Claude artifact (FLOW-4, FLOW-5).**
  - `pmx mcp` is a read-only local server; `pmx mcp --install` registers it with the Claude desktop app.
  - `/pmx-flow` publishes the same view as an artifact that reads PMX on the viewer's own Mac.
  - The server gives the artifact held meetings by rule and number only. Titles, files, hashes, details and to-do text stay on the Mac.
- **The team view (FLOW-7).** Pick "Team" to see the shared run log's runs, agent runs and verdicts, with no meeting content.
- **Edits that only tighten (FLOW-6).**
  - `pmx never-ingest add --title|--person|--channel`, and the artifact's "Stop reading meetings like this", add to your do-not-read list.
  - Before saving, they preview what the rule would have held in the last 14 days.
  - The edit log records only that a rule was added, never the entry.
  - Loosening a rule stays in Terminal.
- **Records that make the links real.**
  - Each task records the Linear issue it became, or the one it duplicated. Through the Claude relay, `PENDING-…` identifiers resolve after the next sync.
  - Receipts keep each source's connector and Slack channel, and held meetings' identity hashes.
  - The run log's synthesis and digest entries name their receipt.
  - Each day's cap is kept.
  - The collection task reports how many meetings it skipped before saving, as counts only.
  - Receipts are kept for the full 14 days at hourly runs.
- **The Linear sync and meeting collection write files with Claude's file tool**, not a shell command. A shell command stopped for an approval nobody saw.
- **Fix: `pmx login` signs in to the hosted app again.** In 0.10.1 the new profile sign-in took that name and hid it. PMX's own Claude profile now signs in with `pmx claude login`, and `pmx claude` shows whether it's signed in. A test now fails if two commands share a name.

## 0.10.1: runs that fail say so

Fixes from a tester's install on Node 22.2 with Claude Code installed by npm under nvm. Their background job failed every 30 minutes for over a day, and nothing showed it.

- **A failed run shows Claude's own error (RUN-ERR-1).** A run that wasn't signed in printed `Synthesis run failed: success`. Claude Code marks such a run as an error but its type stays "success", so PMX now shows Claude's message ("Not logged in · Please run /login") and the fix.
- **`pmx login` signs in PMX's own Claude profile.** Runs use their own profile in `~/.pmx/claude`, so your personal setup never loads, and that profile needs its own sign-in. `pmx init` offers it, doctor fails while the profile isn't signed in, and runs stop before they start instead of failing.
- **The background job finds Claude Code wherever your shell does.** `pmx init` saves the full path to Claude Code in the job and puts its folder on the job's PATH, so an npm install under nvm no longer fails with `spawn claude ENOENT`. Doctor fails when the job can't find Claude Code. Run `pmx init` again to fix a job registered by an older pmx.
- **A job that keeps failing shows (OBS-2).** `pmx status` shows the job's last pass, and doctor warns after three failed passes in a row, with the first error and the log's path.
- **"Set up" tasks that don't run show (CLAUDE-4).** `pmx schedule` and doctor show each task's last run. They warn when a run started and didn't finish, which usually means it waits for an approval nobody saw (the app skips later runs meanwhile), and when a task's scheduled time passed with no run. Runs from before this version left no record, so that clock starts at the update. `pmx schedule` also says where the task files are.
- **An unsupported Node stops the install,** with the steps in order: install Node 24 (Homebrew, or `nvm install 24 && nvm alias default 24`), open a new Terminal, install pmx again, run `pmx init`. Doctor gives the same steps.

## 0.10.0: a solo install that works

Fixes from a first-time install, so one PM can install PMX on a fresh Mac without help.

- **A prebuilt release package (INSTALL-1).** Each version tag publishes `productmaxxing-<version>.tgz` and `SHA256SUMS` as a GitHub release on the public repo. The package has no dependencies, so installing it builds and downloads nothing: no `tsc: command not found`, no Node range warnings, no audit warnings.
- **`INSTALL.md`, written for Claude Code (INSTALL-2).** Say "Install PMX following …/INSTALL.md" and Claude asks you to switch auto mode off, checks the Mac, installs the package after checking its checksum, walks you through `pmx init`, reads `pmx doctor --json` and sets up the scheduled tasks.
- **`pmx init` checks every answer (INIT-1).** It explains what the PMX repo is. A command pasted into the wrong prompt, an invalid folder, URL, handle, category, time or amount is asked again, up to three times. A new working-days question accepts `Mon-Fri` or `Mon,Wed,Fri`. Working hours must be `HH:MM-HH:MM`, and the spend question says that 0 pauses the agent. A summary of every answer comes before anything is saved, and saying no saves nothing.
- **Security fix:** `pmx init` passes a git URL to `git clone` after `--`, so an answer like `--upload-pack=…` can't run a command.
- **`pmx doctor --json`** lists failed checks and warnings by id, for install scripts and Claude.
- **Doctor and runs find Claude Code in `~/.local/bin`** (and other installer folders) when it isn't on your shell's PATH.
- **Node 22.12 or later, or 24 or later** (`engines`, doctor, README). Node 24 from Homebrew is recommended. Doctor warns when Node runs from nvm or another version manager, because the background job breaks when that version is switched or removed.
- **`pmx update --latest`** installs the newest public release after checking its SHA256SUMS, so a team lead can update without building from source, then share it with `pmx vendor --require`.
- New PMX repos' run-record workflow falls back to the release package instead of npm, where PMX isn't published.
- Contributors: vitest 5 (no audit findings), `.nvmrc`, `npm ci`, and CI checks the oldest supported Node.

## 0.9.1: no false alarms, and scheduled runs that don't stall

Fixes from a first-time install.

- **`pmx doctor` checks Linear the way this Mac reaches it.** Going through Claude (the default) no longer fails "Linear token in the keychain". Doctor instead warns when the Claude sync is stale, is for the wrong project, or has changes failing. A Claude Pro or Max plan no longer warns either: PMX runs on your Claude subscription.
- **Doctor warns when the team package is older than this Mac.** Teammates who install or update would get the older version, so it tells the team lead to run `pmx vendor --require`.
- **Linear sign-in is hidden (LINEAR-1 deferred).** ProductMaxxing's Linear app isn't registered, so `pmx linear login` couldn't work. PMX reaches Linear through your Claude app by default. `pmx init` no longer asks for a Linear key, and `pmx linear key` stores one for advanced use (the company roll-up needs one). Anyone already signed in keeps working, and `pmx uninstall` now removes that sign-in too.
- **Scheduled runs don't stall (CLAUDE-3).** A run waiting on a permission prompt nobody answers blocked every later run. With your OK, `pmx init` and `pmx schedule --allow` add always-allow rules for PMX's own command and folder to your Claude settings. Doctor warns while they're missing.
- **`/pmx-schedule` updates tasks with an older prompt**, not just missing ones. It stops when run by a schedule, and asks you to turn auto mode off first. Task prompts now say never to create or change scheduled tasks. `pmx schedule` says the tasks run on this Mac only, in local time, while the Claude app is open, and where to see their runs.
- **`pmx init` ends with one "Next step" block**, printed after the doctor checklist.
- **The background job's logs are capped (OBS-1)** at 1 MB each, keeping one previous file.
- The lockfile matches `package.json` again, and CI checks that it stays that way, so `npm install` no longer blocks the next `git pull`.

## 0.9.0: the team board inside Claude

- **`/pmx-board` (BOARD-1).** The team board as a live Claude artifact: pool → ready → in flight → review → done, read from your Linear project through each viewer's own Linear connector, so it needs no hosted app, API key or sign-in. It moves cards between the pool and Ready (with category and size) when someone clicks; agents, runs and reviews stay in PMX. Offered only when PMX is used with Claude: `pmx init` adds `/pmx-board` beside `/pmx-schedule` when Claude is set up and the team uses Linear (or run `pmx board --install-skill`). Type it in the Claude app and Claude publishes the page PMX prepared, with exactly the Linear tools it needs.
- `pmx board` shows the board's link, `--open` opens it, `--json` / `--html` prepare the page, `--set-url` saves the link. A board committed in `pmx.config.json` (`board.url`) is the team's, so teammates open it instead of publishing their own.
- `pmx canvas` opens the Claude board when there is one. `pmx doctor` warns when it's missing or was published by an older pmx.
- Installed Claude commands (`/pmx-schedule`, `/pmx-board`) refresh themselves after a PMX update.

## 0.8.0: /pmx-schedule in your Claude app

- **`/pmx-schedule` (CLAUDE-2).** PMX can't reach the Claude app's scheduling tool, but Claude can from inside an app session. `pmx init` offers to add a `/pmx-schedule` skill to your personal Claude skills (or run `pmx schedule --install-skill`). Type it in the Claude app and Claude creates each scheduled task this machine is missing, exactly as PMX lists them (`pmx schedule --json`), with one approval. PMX refreshes its own copy and never overwrites a skill you wrote.
- `pmx schedule`, `pmx init` and `pmx doctor` point to `/pmx-schedule` once it's installed; the paste-in text stays as a fallback.
- Tests no longer touch the real `~/.claude` (`PMX_CLAUDE_HOME`).
- The Claude plugin's version now matches the CLI.
- Compatibility fixtures for relay files as 0.7.0 wrote them (COMPAT-4).

## 0.7.0: Linear without an API key, and Claude tasks you can see

- **`pmx linear login` (LINEAR-1).** Sign in to Linear in the browser (OAuth with PKCE, no client secret). The access lives in the keychain and renews itself every 24 hours. `pmx linear logout` revokes it; `pmx linear status` shows how this machine reaches Linear.
- **Claude relays Linear when there's no key or sign-in (LINEAR-2).** A scheduled task in the PM's Claude app uses their Linear connector: it applies the exact changes PMX queued (`~/.pmx/linear/outbox.json`), reports each result, and exports the PMX project as a snapshot PMX reads. PMX checks every result and snapshot, keeps every rule in its own code, and holds meeting claims for a day so the ledger stays safe between syncs.
- **`pmx schedule` (CLAUDE-1).** PMX can't create Claude tasks itself, so it lists the ones this machine needs, says whether each exists, and prints a request to paste into the Claude app. `pmx init` points to it, and `pmx doctor` warns about missing tasks.
- Compatibility fixtures for files as 0.6.0 wrote them (COMPAT-4).

## 0.6.0: automatic updates

- **Background auto-update (COMPAT-6).** When a team turns it on (`pmx vendor --require --auto-update`), every machine's background job checks hourly and installs the team's version from the PMX repo when it's newer. It never downgrades, and never replaces a source checkout. If npm needs `sudo`, PMX can't type a password, so it says so once per version, in a notification and in `pmx doctor`.
- `pmx update` and the background job share one installer.
- Compatibility fixtures for files as 0.5.0 wrote them (COMPAT-4).

## 0.5.0: explainable runs, free hosted app, brain, meetings from connectors, safe updates

Everything since 0.4.0, which shipped several times under that number:

- **Explainable runs (PRIV-4):** `pmx explain [--web]` and `pmx skills`: what each run read, left out, cut and masked, which skills ran, and why each task got its size.
- **Free hosted app (PLAN-1 to PLAN-4, PRIV-5):** `pmx login` signs in for free and creates the team's org; the board is free; content-free analytics start only after sign-in (`pmx analytics`).
- **The brain (BRAIN-1 to BRAIN-5, Team plan):** `pmx brain` proposes actions; fixed rules decide what's done, queued or only suggested; every action is commented and explained.
- **Meetings from Claude connectors (COLLECT, MEET, TODO, COMPANY):** `pmx collect`, a meeting ledger in Linear so no meeting is processed twice, private `pmx todo`, and `pmx company` roll-ups.
- **Safe updates (COMPAT-1 to COMPAT-5):** `pmx update`, `pmx vendor --require` for a team minimum version, files from a newer pmx are refused instead of misread, compatibility tests against what 0.4.0 wrote, and a version handshake with the hosted app.

## 0.4.0 (M5): control plane client, canvas and managed settings

Team-plan features in `ee/` (commercial license), against the API in `docs/control-plane-api.md`:

- `pmx login`: browser sign-in through the control plane; the machine token goes to the keychain. `init --invite` joins the org in the same browser trip.
- Admin policy (ADMIN-2): applied as an intersection with team config (categories, sources, egress, model, review cap). Runs stop on a disallowed model plan. Cached for an hour; fails closed after 7 days without the server.
- License (ADMIN-4): ES256 JWT verified offline, against a pinned production key once one ships.
- Cloud lease (`"lease": "cloud"`): DynamoDB conditional writes with fencing tokens.
- Linear OAuth broker (ADMIN-3): short-lived brokered token, so no personal Linear key.
- Content-free event sync (P7): run and verdict metadata only, checked against the server's strict schema.
- `pmx canvas` opens the hosted canvas (CANVAS-1..4, in `productmaxxing-cloud`).
- Managed-settings template for device management (B7, ADMIN-5).

## 0.3.0 (M4): design-partner beta

- `pmx review`: terminal review queue with accept, reject and redo-with-note (REV-2). Accept merges the PR and marks the task done; reject blocks it with the reason; redo closes the PR, adds the note to the task and returns it to ready.
- `pmx review --web`: a review page on 127.0.0.1 with the rendered draft, citation hovercards showing the approved source quote, and the run record. Token-guarded, loopback Host only, strict CSP, all draft HTML escaped. Works at phone width.
- Verdicts go to the run log; `pmx review --stats` shows accept rate per category (MET-1).
- Auto-pause (REV-3, `ee/`): a category under 30% acceptance with at least 5 reviews in 30 days stops being pulled until `pmx review --unpause <category>`.
- `pmx doctor` suggests new size estimates from the run log (PULL-10).

## 0.2.0 (M3): team pull and atomic lease

- Linear adapter scoped to one PMX project, with label groups (`pmx-status`, `pmx-category`, `pmx-size`, `pmx-agent`) instead of custom fields. Writes outside the project are refused (SEC-4).
- `pmx synthesize`: team sources → candidate tasks with category, size, rationale and cited quotes, posted to the inbox only. No tools in the run (SEC-1). Triage stays human (SEC-2).
- `pmx pull`: budget provider (declared cap, ledger, override; team per-machine cap wins), working hours, review-queue cap (default 3), L/XL guard near the reset, dry-run explanations (default in week one).
- Git-ref lease (`refs/pmx/claims/<id>`): exactly one push wins; stale claims are released with the current token only.
- Run envelope: worktree per task, clean profile, file tools only, per-run spend cap, checklist, run record, PR, tracker comment and status.
- `pmx verify-record` + PMX repo workflow: PRs with outputs and no clean run record fail CI (B5).
- `pmx neutrality`: fixtures in a clean copy, reports comparable across machines (B6).
- Kill switch (`pmx.stop`) checked by every puller and every tick.

## 0.1.0 (M2): single-player digest and open-source skills

- `pmx init`: macOS setup. Detects Claude Code, sets up or joins a PMX repo, stores secrets in the keychain, writes the clean run profile and registers one launchd job.
- `pmx digest`: weekly digest from allowlisted transcript folders and one Slack channel. Personal content is held back (B2), PII is redacted (SEC-8), every claim is cited (SIG-3), and nothing is committed until the PM approves it (PRIV-3). Optional Slack DM.
- Clean run profile (B1): `~/.pmx/claude`, project-only settings, auto memory off, strict MCP config, claude.ai connectors and sync off, reads and writes limited to the repo, sandbox on, permissions never skipped.
- Shared team memory (B4): `memory/` in the PMX repo, loaded through the project `CLAUDE.md`, protected by CODEOWNERS.
- `pmx doctor`: green/red checklist with every clean-profile check and a model-plan warning.
- Run log: `runs/YYYY-MM.jsonl` on the `pmx/runlog` branch, hash-chained per agent.
- Skills pack: pmx-digest, pmx-synthesize, pmx-size, pmx-pull, pmx-research, pmx-competitive, pmx-hygiene, pmx-spec, each with fixtures and smoke tests. Installable as a Claude Code plugin.
- License: Apache-2.0, with team features under `ee/` (commercial).
