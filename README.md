# ProductMaxxing

**Max out your product team's performance.** ProductMaxxing turns every customer call, Slack thread and ticket into sized work in Linear and puts each PM's AI agent on the highest-value task it can finish. You review. *PMX (product maxxing)* is the practice: keep your team's agent budget working on the backlog, paced by human review.

This repo is the product: the `pmx` CLI and engine, the skills and the PMX repo conventions. The website lives in `productmaxxing-website`, and the hosted app is a separate, closed-source service.

## Install (macOS)

With Node 22.12 or later (24 recommended: `brew install node`), in Terminal:

```bash
npx --yes productmaxxing@latest install
```

Four steps and about five questions, in [INSTALL.md](INSTALL.md): (1) that one command, which installs PMX and goes straight on to setting it up (`pmx init`); (2) answer its few questions; (3) quit and reopen the Claude app and type `/pmx-setup`, and in one chat Claude creates PMX's scheduled tasks and publishes PMX's page and your team's board; (4) click Run now and Always allow on each PMX task.

`pmx install` checks your Mac, installs PMX where npm can write without `sudo` (npm's own folder, or `~/.local` when that one belongs to the system), and makes sure a new Terminal window finds `pmx`: if it wouldn't, it asks to add PMX's folder to your PATH in `~/.zshrc` (one marked block), then checks again and says plainly whether `pmx` is found. In Terminal, on a Mac that isn't set up yet, it then runs `pmx init` with the pmx it just installed; `--repo <your team's repo URL>` hands the repo on, so setup doesn't ask where it is. Running it again changes nothing. Or open Claude Code and say *"Install PMX following https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md"*: Claude takes you through the same steps and checks the result.

**PMX is for every PM. PMX Engine is for your team's product lead.** Your team names its product lead in `pmx.config.json` (`"productLead": "<their PMX handle>"`, reviewed like every team setting); installing PMX asks only that person whether to add PMX Engine too. To install it on purpose: `npx --yes productmaxxing@latest install --engine`. `pmx update` then updates both.

The package is prebuilt and has no dependencies, so installing it builds nothing. To install by hand from the release package and its checksums instead, see the appendix in [INSTALL.md](INSTALL.md). Joining a team that already uses PMX? `pmx init` joins its repo, and `pmx update` installs the team's version. Use Homebrew's Node rather than nvm: the background job remembers Node's path, and nvm switching or removing a version breaks it.

`pmx init` asks only what PMX can't work out itself. Joining a team, that's where your team's PMX repo is (its git URL, which PMX clones, or the folder you cloned it to), one yes, and on a Linear team your Linear API key: three questions at most. Starting a team, it's Return for a new repo, the team's name, its Linear team and project, one yes, and your Linear API key: six. Before it asks for the key it says where to create it in Linear and the least it must be allowed; Return there means "use the Claude app instead", and it doesn't ask again (see "Linear" below). It asks for your company's email domain only when neither your team's settings nor your git email says it (PMX needs it to tell colleagues from customers; without one it holds every meeting), and for a GitHub token only when your repo is on GitHub and `gh` isn't signed in. Everything else it works out and shows in its summary: your handle, your Claude plan, every kind of work your team has, PMX's transcripts folder, an empty do-not-read list, and on a Claude plan no dollar cap of your own, because the dollars are only an estimate (your plan's own limits and your team's cap still apply). `pmx init --ask` asks about each instead, as it did before.

The one yes covers everything `pmx init` changes outside its own folder (`~/.pmx`), listed together with what each changes and where: the background job (launchd), PMX's commands in your Claude app (`/pmx-setup`, `/pmx-schedule`, `/pmx-flow`, and `/pmx-board` on a Linear team), the always-allow rules in your Claude settings, and PMX's local server in the Claude desktop app's settings, so PMX's page in Claude works with nothing running in Terminal. `yes` makes them all, `pick` asks about each, `no` saves nothing; nothing on the list happens without your yes. It checks every answer (and asks again if one is wrong), stores tokens in the keychain only, writes a clean run profile, and opens your browser once to sign in PMX's own Claude profile. Running it again asks nothing it already knows and changes nothing that's in place. Then:

```bash
pmx checklist     # where this Mac stands: each install, setup and update step, what runs, what's next (--json for Claude)
pmx doctor        # green/red checklist, including every clean-profile check (--json for scripts)
pmx claude login  # sign in PMX's own Claude profile, which agent runs use
pmx digest        # this week's digest from your transcripts, approved before it's committed
```

Not sure where you stand? In the Claude app, type `/pmx-setup`. Claude runs `pmx guide` (written for Claude, for the version you have) and `pmx checklist`. It tells you what's done, what runs and what's missing, then walks you through the next step. The checklist is worked out from what's actually on this Mac each time. The background job refreshes it on every run, and PMX's page shows it under Health → Setup, with the next required step as a card in Needs you. Every step PMX can do itself there is a button (turn on automatic runs, refresh the background job, add PMX's commands to the Claude app, let its scheduled tasks run, update PMX…); one that changes the background job or the Claude app's settings asks you on the Mac first. Claude's steps show the slash command to type, with Copy, and a step only you or a teammate can do says so in a sentence. `pmx checklist --fix <step>` does the same in Terminal. Health → Running shows what PMX is doing on this Mac right now and the memory it uses: an agent run is one Claude Code process, usually 400–550 MB, one at a time.

The skills also install as a Claude Code plugin: `/plugin marketplace add kp-prodgit/productmaxxing`.

## Commands

| Command | What it does |
|---|---|
| `init` | Set up this Mac: PMX repo, clean profile, skills, keychain, background job. Asks only what PMX can't work out, and takes one yes for what it changes outside `~/.pmx`; `--repo <folder or git URL>` names your team's repo, `--ask` asks everything. Safe to run again |
| `setup` | The Claude app's part of setup (PMX's scheduled tasks, its page, your team's board) and what's left of it. `--prompt` prints what `/pmx-setup` follows to do it all in one chat |
| `checklist` | Where this Mac stands: every install, setup and update step with what's done, what runs and the next step and who does it. Where PMX Engine is installed, its own steps follow PMX's. `--json` for Claude (with Engine's under `engine`), `--fix` redoes what an update does by itself, `--install-skill` adds `/pmx-setup` |
| `guide` | The guide Claude follows to install, set up, update and check PMX with you, for this version |
| `migrate` | What the last update did on this Mac and what's still to do (`pmx update` runs it) |
| `doctor` | Checklist; fails if any clean-profile check is missing, or a kind of work's skill is in neither your team's repo nor PMX (one only PMX ships warns, with the `pmx skills update` that sends it to your team); `--json` for install scripts and Claude |
| `digest` | Weekly digest from allowlisted sources, every claim cited, approved before commit |
| `status` | What needs you, in one line (with PMX Engine's steps that are yours, where it's installed), then config (with your team's product lead, when it names one), kill switch, today's usage (tokens, and dollars at list prices) and recent runs |
| `proposals` | New tasks PMX suggested from your calls, waiting for you, exactly as Linear would get them. `start <n>` or `--all` sends them to Linear as Ready for agents (Start now, when your team allows it); `approve <n>` or `--all` sends them to your team's backlog; `drop` discards them; `theme <n> "<theme>"` (or `none`) sets the roadmap theme a task carries as a label, from your team's open themes. Nothing reaches Linear before you approve |
| `evidence` | Counts of approved tasks per roadmap theme, and per kind of work for tasks without a theme, with the sources they cite and the first and last day: no titles, quotes or meetings. Each task counts once. `--json` prints them for PMX Engine's studio: `pmx evidence --json \| pmxe propose -` (`--format 1` for PMX Engine 0.14 or earlier) |
| `budget` | Your daily cap on PMX's usage: `set <dollars>`, `off` (only your plan's limits and the team cap), or `set 0` to pause PMX |
| `open` | Your PMX workspace on this Mac, like `flow --web`. `open roadmap` opens your team's roadmap page, the PMs' page in PMX Engine, when `pmx.config.json` has its link. `open studio` opens PMX Engine's studio where it's installed. `--hide-studio` takes PMX Engine's Strategy area out of your page, here and in the Claude app |
| `flow` | Your workspace. It opens on Needs you: every decision waiting for you (drafts to review, tasks stopped after failed runs, tasks to approve, the digest, fixes, kinds of work your team added that your agent doesn't take yet, team changes), in the order that unblocks the most, with who acts and how long each has waited. Then Work (the team's tasks by state, agents, the digest), Strategy where PMX Engine is installed (what waits on the head of product, Claude or a colleague, the releases in flight and the pages, read live from Engine, with Open in the studio), Health (status, what's running and its memory, setup, activity, the flow map and Settings) and your own to-dos (Today, Upcoming, Anytime, Logbook). `--web` opens it on this Mac (it stops by itself after 4 hours unused); `--install-skill` adds `/pmx-flow`, which publishes the same workspace as a live Claude artifact that works through the Claude app once you click Connect and allow it on your Mac, and from 0.36.0 updates itself after each PMX update |
| `sources` | Where PMX listens: your meeting apps, recorders you add (`add Momentum`, `add "Google Meet"` for Gemini notes and Meet transcripts through Google Drive, `--only "calls tagged Discovery"`; `remove`), your team's approved channels, and what each may feed (`set granola off`, `mine` for your to-dos only, `linear` for to-dos and team tasks). The board's Sources tab does the same, and sends new team channels to your team for approval |
| `domains` | Your company's email domains, which tell colleagues from customers: `add` or `remove` |
| `categories` | The kinds of work your agent takes on, and the ones you haven't chosen about yet: `add <kind>` turns one on for your agent and `remove <kind>` keeps it off, as Settings → Kinds of work on PMX's page does. A kind your team added that you haven't chosen about shows in Needs you and `pmx status` until you do |
| `whats-new` | What changed in this pmx, or `--since <version>`; PMX also shows it once after every update (`--json` for Claude) |
| `never-ingest` | Your do-not-read list; `add --title`, `--person` or `--channel` adds an entry and says what it would have held; `remove` takes one off |
| `mcp` | The local server the `/pmx-flow` artifact reads through (its only write adds to your do-not-read list); `--install` registers it with the Claude desktop app |
| `claude` | PMX's own Claude profile, which agent runs use: `login` signs it in |
| `explain` | How a run decided: what was found, used, left out, cut and masked, which skills and model ran, why each task got its size, and the cost. `--web` opens a local page |
| `skills` | The Claude skills PMX can use, what each does, when it runs, and whether your team's copy differs from the built-in one. `update <pmx-skill …>` sends this pmx's copies to your team in a pull request (the size rubric keeps your team's rows) |
| `jobs` | Your team's kinds of work, and which your agent takes (`pmx categories add` or `remove` changes that). `add decision-brief` sends one of PMX's kinds your team doesn't have yet (its config line, size row and skill) in a pull request; `template` and `new --from` define your team's own |
| `linear` | How PMX reaches Linear, and how that's doing (`status`): with your own Linear API key by default, or through your Claude app's Linear connector. `key` pastes, replaces or checks your key (it says where to create one), `key --remove` goes back to the Claude app's sync; `written` lists everything PMX wrote there, `tidy` rewrites what older versions wrote (meeting excerpts, meeting titles), `withdraw <id>` cancels a task and removes its text |
| `board` | The team board as a live Claude artifact (only when you use Claude and Linear): the link, `--open`, and `--install-skill` for `/pmx-board`, which publishes it from inside the Claude app |
| `schedule` | The scheduled tasks PMX needs in your Claude app and whether each is set up and current; `--install-skill` adds `/pmx-schedule`, which creates or updates them from inside the Claude app; `--allow` lets them run `pmx` without stopping for permission; `--hours always\|weekdays` sets when they work (always, every day, unless you choose weekdays) |
| `collect` | Calls and channel threads from your Claude connectors (Granola, Google Meet, Momentum, Slack…): `--prompt` prints the scheduled task's instructions, `--check` validates what it saved and deletes anything from a place your team didn't approve |
| `todo` | Your own to-dos from your meetings, including 1:1s; never leaves your Mac. `--refresh` reads today's unread meetings, `done <id>` checks one off |
| `move` | Move work between a private to-do, a to-do in Linear (yours; agents skip it) and a product task for the team, in any direction: `pmx move <to-do, new task or PMX-12> private\|todo\|product`, with `--kind` (and `--size`) for product, which a to-do taken back from a team task already has. Taking work out of Linear cancels it there with a comment, never deletes it |
| `synthesize` | Today's unprocessed customer calls and approved channel threads → new, sized tasks waiting for your approval (`pmx proposals`). A meeting saved by two recorders is read once, and a need already open or waiting gets the new sources instead of a second task |
| `company` | Roll teams' PMX tasks up into company-level themes; reads tasks, never transcripts |
| `pull` | Claim the best Ready task that fits the budget and the review cap, and start an agent run on it (practice mode in week one). A task's cost estimate is the median of its kind of work's last 10 good runs at that size, or your team's size table until there are 3; `--dry-run` says which |
| `claim` / `release` | Claim a specific task; give one back; `--stale` gives back expired claims |
| `verify-record` | CI check: every draft's PR carries a clean run record |
| `vendor` | Put this CLI's package in the PMX repo, so teammates and CI install the same version; `--require` makes it the team minimum. Every Mac's background job then installs it by itself, unless the team turns that off with `--no-auto-update`. `--latest` is the team lead's whole update in one command: the newest release, checked, in a pull request it opens |
| `install` | Install PMX on this Mac and make sure a new Terminal window finds it (before PMX is installed: `npx --yes productmaxxing@latest install`). In Terminal, on a Mac not set up yet, it goes straight on to `pmx init`; `--repo <folder or git URL>` hands your team's repo on to it. `--yes` adds PMX's folder to your PATH without asking; `--engine` installs PMX Engine too, which only your team's product lead is otherwise asked about |
| `update` | Install your team's version from the PMX repo, and update PMX Engine with its own updater where it's installed; `--check` only compares; `--latest` installs the newest public release (for the team lead); `--next` installs the newest test build (only for testing PMX before a release) |
| `neutrality` | Run skill fixtures in a clean profile; `--compare` two machines' reports |
| `review` | Accept, reject or redo-with-note in the terminal, or `--web` for a local review page; without a terminal, `--accept <PMX-12 …>`, `--redo <PMX-12> --note "…"` or `--reject <PMX-12> --note "…"`; `--stats` for accept rates; `--stopped` lists tasks PMX stopped after failed runs, `--retry <PMX-12>` puts one back in Ready with its count started over, `--drop <PMX-12>` cancels it. Accepting a local draft leaves your own edits alone. Accepting adds the draft's follow-ups: its PM decides calls to your to-dos, its open questions as new tasks marked Follows PMX-12, waiting for your approval (`"followUps": false` in `pmx.config.json` turns that off) |
| `login` | Sign in to the free hosted app; creates your team's free org if there isn't one |
| `canvas` | Open the team board: the Claude board if there is one, else the hosted app (free) |
| `analytics` | What this machine sends to your hosted org; `--show` prints the pending events, `on` / `off` |
| `brain` | Free: assess the board and suggest, queue or (on autopilot) take the next actions, each with a reason; `--review` approves what's waiting, `--why` explains its last run |
| `policy` / `license` | Show the applied admin policy; show or refresh the license that cloud leases need (`ee/`) |
| `tick` | One background run (launchd runs it every 30 minutes) |
| `uninstall` | Remove the job, profile, keychain items and `~/.pmx` |

## Linear

PMX reaches Linear **with your own Linear API key** by default (from 0.41.0). `pmx init` asks for it once on a Linear team, and `pmx linear key` pastes or replaces it any time. With it PMX reads and writes your team's PMX project itself: what you approve is in Linear at once, and every background run (every 30 minutes while this Mac is awake) picks up what your team changed there. No scheduled task in the Claude app is in between, and working hours don't apply to it. `pmx linear status` says how it's doing.

**Creating the key.** In Linear: Settings → Account → Security & access → Personal API keys → New API key. Give it:

- **Permissions: Read and Write.** PMX reads the project, the team's labels and workflow states, and who the key belongs to (Read); and it creates its tasks, labels them, moves them between states, assigns them, comments on them and creates its own `pmx-…` labels in the team (Write). "Create issues" and "Create comments" alone aren't enough, because PMX also labels and moves its tasks. It never needs **Admin** or full access: it changes no workspace or team setting and never creates, renames or reorders a workflow state.
- **Team access: only the team that holds your PMX project.** The head of product's Mac, which runs the company roll-up, also needs **Read** on each team the roll-up reads; setup and `pmx checklist` name them, and say which one the key couldn't read.

**What the key can do, and where it's kept.** It acts as you, in the teams you gave it, for as long as it exists: a key doesn't expire until you revoke it in Linear (the same page). PMX uses it only for your team's PMX project and refuses to write to any issue outside it. You paste it into PMX's own prompt, which doesn't show it; PMX checks it with one read (whose it is, and that it sees your team's PMX project), makes sure PMX's own labels exist in the team, and only then saves it, in this Mac's keychain and nowhere else: not in `~/.pmx`, your team's repo, a log, a receipt or an error message. A key that can't see the project, or can't write, is refused with what's missing, and nothing is saved. Never paste it into a Claude chat. `pmx uninstall` and `pmx linear key --remove` take it out of the keychain.

**When something is wrong with it.** A key Linear no longer accepts (revoked, or its access changed) is said plainly in the background run's log, in one notification, in `pmx status`, `pmx doctor`, the checklist and PMX's page, with the two ways on: paste a new one (`pmx linear key`) or go back to the Claude app's sync (`pmx linear key --remove`). PMX never switches to the Claude app's sync by itself. When Linear's rate limit is reached PMX waits until the time Linear gives, says so once, and loses nothing.

**How much it asks Linear.** Each background run asks only for the issues that changed since the last one, usually none; once a day, at its first run, it reads the whole project, so an issue deleted or moved out of it leaves PMX's copy within a day. PMX keeps that copy on this Mac (`~/.pmx/linear`) for its page and the checklist, which never ask Linear anything themselves.

### Without a key: through your Claude app

Can't create a key (a workspace's admins can turn member keys off, in Settings → Administration → API), or would rather not? Press Return when setup asks. PMX then reaches Linear **through your Claude app**, with no key or sign-in: a scheduled task uses the Linear connector in your Claude app to apply the exact changes PMX queued and bring back the PMX project. PMX checks every result and keeps all the rules in its own code; Claude only carries the changes. Changes reach Linear at the next sync (every hour, every day, while the Claude app is open and the Mac is awake), not instantly. A sync with nothing to carry asks Linear only what changed since the last one; once a day, and whenever PMX has changes for Linear's issues, it brings back the whole project. `pmx linear status` shows when it last synced. The company roll-up reads several projects, which this way doesn't cover: its Mac needs a key.

**Moving from the Claude app's sync to a key** is `pmx linear key`, and loses nothing. PMX reads the project itself straight away, so its page never shows a gap; sends everything still queued for the sync straight to Linear, in order; and records each new task's real identifier the way a sync would have, so quotes waiting to be shared and to-dos you sent to the team still find their tasks. If a sync is running in the Claude app at that minute, PMX leaves that run's changes to it and takes in what it applied, so nothing is applied twice. The "PMX: sync Linear through Claude" task is then no longer needed: PMX says once that it's safe to delete (Claude app → Code tab → Scheduled), and if it still runs it does nothing.

### What reaches Linear, and when

- **You approve every task first.** `pmx synthesize` (and the background job) keep new tasks in `~/.pmx/staging`. `pmx proposals` shows each one exactly as Linear would get it: title, labels and description, plus, for your eyes only, which meetings it came from and why. Start one, several or all now (Ready for agents at once), approve them for later (they wait in your team's backlog until someone moves them to Todo in Linear), or drop them. A team where someone else decides what agents take turns Start now off with `"approve": { "startNow": false }` in `pmx.config.json`; then approving sends a task to the backlog and a teammate makes it Ready.
- **Linear's own status and assignee follow PMX.** A task in the backlog sits in Linear's Backlog, Ready in Todo, a draft in progress in In Progress, a draft waiting for review in your team's review status (In Progress if there's none), and an accepted one in Done, with its completed date. When an agent takes a task, the issue is assigned to the PM whose Mac drafts it. PMX also follows your team's moves in Linear: Backlog → Todo makes a task Ready for agents, back to Backlog takes it out, and canceling drops it; closing a task in Linear never counts as accepting it. PMX sets no priority; agents take higher-priority Ready tasks first. The `pmx-status` label stays PMX's own record. See "Linear's own status follows PMX's" in [GUIDE.md](GUIDE.md).
- **When a draft is ready**, the task's comment in Linear says what the draft is in a sentence or two from its summary, how many questions and "PM decides" calls it leaves, and where to read it: the pull request, or the file in the team repo on the drafting PM's Mac until it's accepted.
- **After you accept a draft**, its "PM decides" calls become your own to-dos, on your Mac only, and its open or blocking questions become new tasks marked "Follows PMX-12" that wait for your approval like any suggested task: up to 3 per draft, blocking questions first, and up to 5 to-dos; the rest stay in the draft. Nothing reaches Linear until you approve one; each carries the question and the draft's recommendation in the draft's words, and the original task's source IDs.
- **The quotes a task cites go to your team repo, not to Linear.** When you approve a task, PMX puts the passages its agent will cite (only that task's sources, after the privacy rules and redaction) in your team repo at `refs/pmx/evidence/<task>`, so any PM's agent can draft it, not only yours. Everyone with the team repo can read them, so they name no one: each person PMX finds in them is a placeholder that keeps only their company, like `[PERSON-2, Globex]`. PMX deletes them when the task is done or dropped, and within 30 days in any case. Through the Claude app's sync they go once the next sync gives the task its ID. You hear about it only if it fails.
- **Summaries, never transcripts.** A task's description is a short summary in the model's own words, why it got its size, and its sources in words: "a customer call with Acme (Nov 20); 3 threads in #launch (Nov 18–21)". It may name the customer or partner company, the deal stage and deadlines ("Acme's Dec 8 beta"), so a teammate can tell what it serves; never people's names, quotes, meeting titles or anything about fundraising (investors, rounds, valuation). PMX checks every sentence it writes to Linear and leaves out one that breaks these rules, refuses any description that repeats eight words in a row from a meeting or carries transcript markup like "Microphone:", and drops any cited source the model can't say supports the task.
- **Nothing about meetings goes to Linear.** So no teammate processes a meeting twice, PMX records each processed meeting in your PMX repo (`refs/pmx/meetings`), under an ID keyed with your repo, so nobody outside the team can match it to a meeting by guessing. Versions before 0.16.0 put "Processed meeting" items in Linear; PMX still recognises them, and `pmx linear withdraw` cancels them.
- **Taking things back.** `pmx linear written` lists everything PMX wrote. `pmx linear tidy` rewrites what versions before 0.14.0 wrote (meeting excerpts in task descriptions, meeting titles on markers). `pmx linear withdraw PMX-12` moves a task to canceled and replaces its text. Nothing is ever deleted; Linear may keep earlier text in a task's history, so delete the task in Linear to remove it completely.

Teams on the hosted app use its Linear connection instead of either.

**Why a key is the default.** Through the Claude app, PMX sees Linear only as of the last sync, and its changes wait for the next one. The sync runs every hour, every day, but only while the Claude app is open and the Mac is awake (and, if you chose working hours only, on weekdays from 8:00 to 19:00), so a Mac's copy of Linear can be many hours old. With a key, a task moved to Ready is seen on PMX's next background run, within 30 minutes, whether or not the Claude app is open. Without one, each Mac needs its own first sync before it sees the team's tasks; until then PMX says it's waiting for it, at the top of the hour, and `pmx status`, `pmx doctor` and the board say when a sync was missed.

### PMX's scheduled tasks

PMX can't create tasks in your Claude app itself, but Claude can. `pmx init` adds PMX's commands to your Claude app with your yes (or run `pmx schedule --install-skill`). Open the Claude desktop app (Code tab), start a session **with auto mode off** (auto mode can deny the scheduled-tasks tool without saying why), and type `/pmx-setup`, which does the tasks, PMX's page and your team's board in one chat, or `/pmx-schedule` for the tasks alone. Claude creates the tasks this machine needs (meeting collection, and on a Mac without a Linear API key the Linear sync), or updates ones with an older prompt. A Linear sync task left from before you had a key is named as safe to delete, never as something to fix. Then click "Run now" on each task once and approve what it asks.

- **Permissions.** A scheduled run stops at any permission prompt nobody answers, and blocks that task's later runs. `pmx init` adds with your yes, and `pmx schedule --allow` adds later, always-allow rules for PMX's own command and folder (`Bash(pmx *)`, `Read(~/.pmx/**)`, `Edit(~/.pmx/**)`) to your Claude settings. Connectors still ask once, on the first "Run now".
- **This Mac only.** The tasks call `pmx` and write to `~/.pmx`, so they can't run in the cloud.
- **When they run.** Times are your Mac's local time. Tasks run while the Claude app is open and the Mac is awake; a run missed while the app was closed happens once when it opens again. The Claude app starts meeting collection at 12:30 and 17:30 and, on a Mac without a Linear API key, the Linear sync every hour, every day. (With a key PMX syncs Linear itself with every background run, and the hours below are meeting collection's only.) Every run does its work: that's the default from 0.41.0, **Sync whenever PMX runs** in Health → Settings → Schedule (`pmx schedule --hours always`). **Working hours only** (`pmx schedule --hours weekdays`) is the other choice: then each run asks PMX first, and outside your working hours it starts briefly and stops. On working hours the sync works on weekdays from 8:00 to 19:00, so its last run is the 18:00 one, and collection works on weekdays. That's PMX's own setting, so changing it needs nothing in the Claude app. A Mac that never chose moved to every day with 0.41.0, and PMX said so once; a Mac where you chose working hours keeps them. Tasks set up before 0.36.0 need `/pmx-schedule` once more to get this. If you change a task's schedule yourself in the Claude app, PMX keeps your change.
- **Where to see them.** Claude app → Code tab → Scheduled → the task → Runs. `pmx schedule` and `pmx doctor` say which tasks are missing or out of date, when each last ran, and which ones haven't run or didn't finish. A run that waits for an approval blocks that task's later runs: open it and choose "Always allow".

### The board inside Claude

When your team uses Linear and Claude, `pmx init` also adds `/pmx-board` (or run `pmx board --install-skill`). Type it in the Claude desktop app (or `/pmx-setup`, which publishes it in the same chat as the rest) and Claude publishes the team board as a live artifact in your Claude account: backlog → ready → in flight → review → done, read from the PMX project through each viewer's own Linear connector. Everyone works inside Claude, with no hosted app or API key. The board moves cards between the backlog and Ready when someone clicks, and Linear's own status moves with them (Backlog, Todo); moving a task to Todo on Linear's own board does the same. Everything else stays in PMX. After a PMX update that changes the board's page, the board updates itself when you open it (see Updating).

Share it from the artifact's Share menu, then add `"board": { "url": "<link>" }` to `pmx.config.json` in a PR, so every teammate's `pmx canvas` opens the same board. Each viewer allows Linear for the board once.

## Updating

Your team's PMX repo holds the CLI package everyone installs (`.pmx/cli/productmaxxing.tgz`), so a team moves to a new version together. After any update, the first `pmx` command says what's new, once; `pmx whats-new` shows it again.

Each update does what it can by itself, once, on the first background run after it (or the first `pmx` command, if that comes first), based on the version this Mac came from:
- it refreshes PMX's commands in the Claude app, and adds new ones;
- it points the Claude app's PMX server at the new pmx;
- it refreshes the background job's Node and Claude Code paths. When one of them moved, the job reloads itself once the run in progress has ended, so no run is cut short and nobody has to run a command.

Then one line says what's left for you, in a notification, in the job's log and in `pmx checklist`: "Nothing to do." when that's true, otherwise only the steps that need a person. Those are few: republish a page from before it could update itself (a workspace page from before 0.36.0, a team board from before 0.41.0), open the team board once so it takes its newer page, update a scheduled task when its prompt changed, restart the Claude app when you came from before 0.25.1, and run `pmxe update` on the product lead's Mac when a newer PMX Engine is out. `pmx update` ends with the same list (`pmx migrate`).

**Existing machines: what to do**

| This Mac | To update |
|---|---|
| On pmx 0.14.0 or older (named Product Git) | Update as usual below; it just works. Your team's repo and each release carry a bridge copy for older versions; on its first run it swaps the `productgit` npm package for `productmaxxing` and moves your keychain items and background job to their new names. Installing by hand instead? Run `npm uninstall -g productgit` just before the install. |
| On a pmx newer than 0.40.3, and your team hasn't turned auto-update off | Nothing. The background job installs the version your team's repo carries within the hour of the merge, even when the Claude app is closed, and the next `pmx` command says what's new. It installs only that package, which your team's code owners reviewed, never one straight from npm or a release, so your team lead still decides the version. |
| On pmx 0.6.0 to 0.40.3, team has `"cli": { "autoUpdate": true }` | Nothing, as above. |
| On pmx 0.6.0 to 0.40.3 and your team never set it, or your team turned it off (`"cli": { "autoUpdate": false }`, `pmx vendor --require --no-auto-update`) | `pmx update`. It pulls the PMX repo, installs the team's version and prints what's new. Where PMX Engine is installed (your product lead's Mac), it then updates Engine too, with Engine's own updater. After that one update, a Mac whose team never set it updates by itself. |
| The team lead, on a pmx newer than 0.40.3 | `pmx vendor --latest`, and merge the pull request it opens. One command: it gets the newest release after checking its SHA256SUMS, puts it in your team's repo, raises the team minimum, and sends one commit on a branch of its own as a pull request (with `gh` when it's installed and signed in; otherwise it prints the link). It asks once before it pushes, never pushes to your default branch, and leaves your checkout and your git settings alone. Every Mac, yours included, then installs it by itself. |
| Solo, or the team lead on pmx 0.10.0 to 0.40.3 | `pmx update --latest` installs the newest release after checking its SHA256SUMS. Team lead: then `pmx vendor --require`, commit the files it names in a pull request, and merge it. This still works on every later version. |
| Older than 0.10.0, or installed from a source folder | Install the release once by hand (below), then run `pmx init` again: it keeps your answers and re-registers the background job with the new Node and Claude Code paths. |

Install by hand over an older version (this keeps `~/.pmx`, your settings and keychain items; never run `pmx uninstall` to update):

```bash
d="$(mktemp -d)" && cd "$d"
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.40.3/productmaxxing-0.40.3.tgz
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.40.3/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
npm uninstall -g productgit   # only if this Mac had Product Git 0.14.0 or older
npm install -g ./productmaxxing-0.40.3.tgz
pmx whats-new --since <the version you had>
```

Updating from 0.24.0 or older? Quit the Claude app completely (⌘Q) and open it again, so it starts PMX's new server: until then your PMX page in Claude talks to the old one. From 0.25.1 the server switches to a new pmx by itself.

PMX's page in Claude updates itself from 0.36.0: the next time you open it after a PMX update, it publishes PMX's newer page over itself, keeping its link. A page published before 0.36.0 needs `/pmx-flow` once more, after the update to 0.36.0, to get that. The team board does the same from 0.41.0: published once with `/pmx-board` where the Claude app has PMX's server (`pmx mcp --install`), it publishes PMX's newer board page over itself the next time its owner opens it in the Claude app on their Mac, for teammates too. A board published before that reads only Linear, so it needs `/pmx-board` once more, and only when an update changes the board's page. PMX says when one of them needs Claude: after the update, on the page itself and in `pmx doctor`, and it tells Claude too, so a Claude session that ran the update publishes them again itself.

Then run `pmx doctor`. It names anything left to do: for example, `pmx claude login` when PMX's Claude profile isn't signed in, or typing `/pmx-schedule` in the Claude app when a scheduled task's prompt changed.

- **Updating to 0.16.0.** `pmx flow --web` is now the pipeline board, and `/pmx-flow` publishes it: type `/pmx-flow` in the Claude app again to update a page you published. PMX no longer writes "Processed meeting" items to Linear; `pmx linear written` lists the ones older versions wrote, and `pmx linear withdraw` cancels them.
- **Product Git is now ProductMaxxing (0.15.0).** The `pmx` command, `~/.pmx`, your PMX repo and your settings stay the same. The npm package, the keychain service and the background job have new names (`productmaxxing`, `com.productmaxxing.pmx`); PMX moves them on its first run after the update, and `pmx doctor` warns if anything is left under the old names.
- **Updating to 0.14.0.** Tasks now wait for your approval (`pmx proposals`) instead of going straight to Linear. Run `pmx doctor` afterwards: if it says PMX doesn't know your company's email domain, run `pmx init` again and give it (until then PMX holds every meeting). If it says PMX is paused, your daily cap is $0: `pmx budget off` or `pmx budget set 10`. If older versions already wrote to Linear, check `pmx linear written` and run `pmx linear tidy`. Run `pmx init` again too if doctor says the background job's Node or Claude Code path is gone.
- **No working hours since 0.13.0.** PMX works whenever this Mac is on and awake; your budget still limits it. Hours saved by an older `pmx init` are ignored, so there's nothing to change.
- **Auto-update is on unless your team turns it off.** A team that never set `cli.autoUpdate` gets updates by themselves from the version after 0.40.3; before, unset meant off. To keep updating by hand, the team lead runs `pmx vendor --require --no-auto-update` (or sets `"cli": { "autoUpdate": false }` in `pmx.config.json`) in a reviewed pull request. A team whose repo carries no PMX package has nothing to install, so nothing changes for it. The background job never installs PMX Engine: `pmx update` does. After it updates PMX, the job asks Engine's own updater whether a newer Engine is out and tells you once ("PMX Engine 0.x is out: run pmxe update").
- **Test builds.** A version like `0.41.0-next.2` is a build published for testing before 0.41.0 is released. It isn't a release: `pmx update --latest`, `pmx vendor --latest` and `npx --yes productmaxxing@latest install` never give you one, and it counts as older than 0.41.0 everywhere versions are compared. `pmx update --next` installs the newest one on a Mac used for testing, checked against its SHA256SUMS, and moves that Mac to the release once it's out.
- **Auto-update and sudo.** Where npm's global folder needs `sudo` (Node installed as root), PMX can't type the password, so it tells you once to run `pmx update`. Installing Node with Homebrew avoids that.
- **If you don't update:** your digest, to-dos and `pmx explain` keep working, but shared team work (suggesting tasks, pulling, the brain, the company roll-up) stops with a message until you do. That way an old version never writes something the rest of the team's versions would misread. `pmx doctor` says when you're behind.
- **What never breaks within a major version:** shared files and Linear labels only gain things; a file written by a newer pmx is refused, not misread; every release is tested against files older releases wrote; and the hosted API only adds to `/v1`. Details in [docs/control-plane-api.md](docs/control-plane-api.md) ("Versions").

## Free, and the hosted service

Everything that runs on your team's Macs is free, the brain included. What a plan covers is the hosted service.

| Free on your Macs, and the free hosted app | The hosted service's Team plan |
|---|---|
| The CLI, digest, task suggestions, pull, review and every local page | Team analytics: accept rates, cycle time, spend, digest and suggestion volume, brain activity |
| The brain: suggests, queues or (on autopilot, within the limits you set) takes the next actions on the board | Cloud leases, and the signed license they need |
| The hosted board, invites, admin policy and the Linear broker | |
| Content-free analytics events, after you sign in and see what's sent | |

The brain runs on one of your team's machines on your own Claude plan, so task text never reaches ProductMaxxing. Turn it on with a `brain` block in `pmx.config.json`, in a reviewed pull request, for example `"brain": { "level": "recommend", "machine": null, "everyHours": 4 }`. If your org's admin policy in the hosted app sets the brain, the policy decides instead. Fixed rules decide what it may do, every action gets a tracker comment saying why, and it can never approve an agent's draft.

## How it keeps work neutral and personal data out

- **Clean run profile (B1).** Every run uses `~/.pmx/claude`, `--setting-sources project`, auto memory off, `--strict-mcp-config` with no servers, claude.ai connectors and sync off, reads and writes limited to the repo, the sandbox on and permissions never skipped. No run gets web access, with one exception your team can turn on: `"web": true` on the `competitive-analysis` kind in `pmx.config.json` (a reviewed pull request) gives that kind's runs WebSearch and WebFetch, in run settings of their own that open nothing else and that `pmx doctor` checks. Pages are data, never instructions; each claim from the web cites its URL and the date it was read; nothing from your team's evidence goes into a search, which a hook in those settings enforces by blocking any search or page that carries the task's quotes, people or customers; and nobody is looked up. The run record and the review screen say the run used the web. A team with its own copy of the competitive skill takes the new instructions with `pmx skills update pmx-competitive`.
- **Personal-content filter (B2).** Default-deny sources, no DMs, calls only with someone outside your company's email domains (with no domain set, every call is held), and fixed rules that hold back 1:1s (by title, or two people with a title naming two people), hiring and interviews, performance, pay and health. A meeting whose title is about one of those, or that returns to one in two or more passages, is held whole; otherwise only the sentences on it are cut (with the ones around a sentence about a person, or the whole turn when that's most of it), and a direct reply to it right after, never the next passage on another subject. Plus your personal never-ingest list. Internal meetings stay out of team work unless your team approved their series (Settings → Sources → Team meeting series, reviewed like every team setting), and then every other rule still applies. Held material is discarded, never stored.
- **Nothing in git until approved (B3).** Digests are staged in `~/.pmx/staging` and committed only after the PM approves.
- **Shared team memory (B4).** `memory/` in the PMX repo, loaded through the project `CLAUDE.md`, changed only by code-owner-reviewed PR. Where the team uses PMX Engine, `memory/engine/` holds what the product managers' page shows, put there by the head of product's `/pmxe-memory` pull request; tasks never repeat it word for word. Its `themes.json` lists the open roadmap themes, which PMX suggests on new tasks and the PM can apply as Linear labels (`pmx-theme`).
- **Atomic claims.** A claim is a parentless commit pushed to `refs/pmx/claims/<task>`; only one push can win. A claim lasts only while an agent runs, so each task's last step (a draft in review, done, rejected, dropped, back in Ready) is a commit at `refs/pmx/task-state/<task>` that every Mac reads before it drafts, whatever its own copy of Linear says. An approved task's quotes are a commit of their own at `refs/pmx/evidence/<task>`, pushed without force and deleted when the task ends, so no branch history keeps them.
- **Provable runs (B5, NEUT-3).** Each draft's PR carries `.pmx/runs/<task>.json`. CI recomputes the environment fingerprint from the repo and rejects records that don't match.
- **See where data went, and change the rules (FLOW-1 to FLOW-7, BOARD-3).** `pmx flow --web` is the pipeline board on this Mac: counts on every connection from your meeting apps to Linear and back, the skills and scheduled tasks, an audit that checks held meetings against Linear and fake confidential "canary" meetings every run must hold, and every rule, editable. Your own settings apply at once; team settings open one pull request. The `/pmx-flow` artifact is the same workspace in Claude. Before you connect it, it shows counts only: no meeting or task titles, no do-not-read entries. Connecting asks you on the Mac; after that, titles reach only your page, uncached, and a Claude chat can't read them or act without the key you allowed (`pmx mcp --unpair` disconnects).
- **Explainable runs (PRIV-4).** Every digest and synthesis run leaves a receipt in `~/.pmx/receipts` (owner-only, 14 days, never in git). `pmx explain` shows it; left-out text is never stored, and file names and lines are found again in your own folders on screen.
- **Meetings, once.** A scheduled task in your Claude app copies transcripts from your meeting connectors; PMX's own runs never get connectors. Team meetings are claimed while they're processed and recorded in the PMX repo once done, so no meeting is processed twice. Your own to-dos may come from 1:1s, but stay on your Mac.
- **Content-free analytics (PRIV-5).** Only after `pmx login`, and only IDs, sizes, outcomes, counts and cost. `pmx analytics --show` prints exactly what's waiting; `pmx analytics off` stops it.
- **Audit.** The run log is `runs/YYYY-MM.jsonl` on the `pmx/runlog` branch, hash-chained per agent and checked by `pmx doctor`.

## Develop

Node 24 (`.nvmrc`); CI also checks the oldest supported Node, 22.12.

```bash
git clone https://github.com/kp-prodgit/productmaxxing.git && cd productmaxxing
npm ci            # npm ci, not npm install, so package-lock.json never changes under you
npm test
npm run build && node dist/src/cli.js --help
```

### Adding a line to the corpus

`test/corpus/filter/*.jsonl` is a fixed set of lines as people say them, each with what the privacy filter must do with it. `npm test` runs every one through the filter a run uses (`test/corpus.test.ts`), so a rule change that flips a line fails by name. To add a line, add one line of JSON to the file for its family (or a new file); no code:

```json
{"family": "bonus", "text": "Resellers earn a 20% commission on renewals.", "expect": "kept", "topic": null, "why": "What resellers earn is a partner term."}
```

- `text`: one turn, one message, or a short passage. Several turns are `Name: …` lines with a blank line (`\n\n`) between. Use made-up names.
- `expect`: `"kept"` (all of it), `"cut"` (none of it is used), or the exact text left, with `[HELD]` where sentences were cut. `topic`: the rule that cuts it (`compensation`, `health`, `hiring`, `performance`, `one-on-one`, `fundraising`, `confidential`, `never-ingest`…), or `null` when it's kept whole. `why`: a sentence saying why that's right.
- `context`, when the line needs it: `{"speaker": "outside"}` (said by the customer; `"inside"` for a colleague), `"outside_present": false` (an internal meeting), `"confidential": ["initech-ventures.example"]`, `"never": ["Sam Okafor"]`, `"title"`, `"kind": "thread"`, `"scope": "own"` (the PM's own to-dos), `"whole_meeting": true`.
- A line PMX gets wrong today goes in too: write what it does now in `expect` and `topic`, and add `"known_gap": {"want": "kept", "why": "…"}` with what it should do. The test prints the known gaps on every run, and fails when one starts doing what's wanted, until you set `expect` to it and remove `known_gap`.

Run it alone with `npx vitest run test/corpus.test.ts`; a failure shows the line, what was expected and what happened. `test/corpus/follow-ups/` holds draft fixtures (`*.md`) and, in `expected.json`, the follow-ups each must give: kind, wording and fixed ID. After a wording change you mean, `CORPUS_UPDATE=1 npx vitest run test/corpus.test.ts` rewrites that file; review its diff.

Releases: bump the version in `package.json`, `.claude-plugin/plugin.json` and `INSTALL.md`, then push a `v<version>` tag. The release workflow tests, packs and publishes the package with its SHA256SUMS.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR. Requirement IDs in comments
(for example `PRIV-4` or `BRAIN-3`) name the product rule a piece of code implements.

The CLI ↔ hosted app contract is in [docs/control-plane-api.md](docs/control-plane-api.md).

## License

Everything outside `ee/` is [Apache-2.0](LICENSE). `ee/` is source-visible under the
[ProductMaxxing Commercial License](ee/LICENSE) and needs a Team plan to use.
