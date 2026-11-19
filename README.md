# ProductMaxxing

**Max out your product team's performance.** ProductMaxxing turns every customer call, Slack thread and ticket into sized work in Linear and puts each PM's AI agent on the highest-value task it can finish. You review. *PMX (product maxxing)* is the practice: keep your team's agent budget working on the backlog, paced by human review.

This repo is the product: the `pmx` CLI and engine, the skills and the PMX repo conventions. The website lives in `productmaxxing-website`, and the hosted app is a separate, closed-source service.

## Install (macOS)

The easy way: open Claude Code and say *"Install PMX following https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md"*. Claude checks your Mac, installs the release package, walks you through `pmx init` and checks the result. Switch auto mode off first; the guide asks you to.

By hand, with Node 22.12 or later (24 recommended: `brew install node`):

```bash
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.34.0/productmaxxing-0.34.0.tgz
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.34.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
npm install -g ./productmaxxing-0.34.0.tgz
pmx init
```

The release package is prebuilt and has no dependencies, so installing it downloads and builds nothing. Joining a team that already uses PMX? Clone its PMX repo and install the team's copy instead: `npm install -g <repo>/.pmx/cli/productmaxxing.tgz`. Use Homebrew's Node rather than nvm: the background job remembers Node's path, and nvm switching or removing a version breaks it.

`pmx init` doesn't ask for working hours: PMX works whenever this Mac is on and awake. It asks for your company's email domain, so it can tell colleagues from customers (without one it holds every meeting). On a Claude plan it sets no dollar cap of your own, because the dollars are only an estimate; your plan's own limits and your team's cap still apply. It explains the PMX repo, checks every answer (and asks again if one is wrong), shows a summary, and saves nothing until you confirm. Then it sets up or joins your team's PMX repo, stores tokens in the keychain, writes a clean run profile and registers one background job. If the Claude desktop app is on your Mac, it also offers to add PMX's local server to it, so the `/pmx-flow` workspace in Claude works with nothing running in Terminal. Then:

```bash
pmx doctor        # green/red checklist, including every clean-profile check (--json for scripts)
pmx claude login  # sign in PMX's own Claude profile, which agent runs use
pmx digest        # this week's digest from your transcripts, approved before it's committed
```

The skills also install as a Claude Code plugin: `/plugin marketplace add kp-prodgit/productmaxxing`.

## Commands

| Command | What it does |
|---|---|
| `init` | Set up this Mac: PMX repo, clean profile, skills, keychain, background job |
| `doctor` | Checklist; fails if any clean-profile check is missing; `--json` for install scripts and Claude |
| `digest` | Weekly digest from allowlisted sources, every claim cited, approved before commit |
| `status` | Config, kill switch, today's usage (tokens, and dollars at list prices) and recent runs |
| `proposals` | Tasks PMX proposed from your calls, exactly as Linear would get them. `approve <n>` or `--all` sends them to the PMX inbox; `drop` discards them; `theme <n> "<theme>"` (or `none`) sets the roadmap theme a task carries as a label, from your team's open themes. Nothing reaches Linear before you approve |
| `evidence` | Counts of approved tasks per category and roadmap theme, with the sources they cite and the first and last day: no titles, quotes or meetings. `--json` prints them for PMX Engine's studio: `pmx evidence --json \| pmxe propose -` |
| `budget` | Your daily cap on PMX's usage: `set <dollars>`, `off` (only your plan's limits and the team cap), or `set 0` to pause PMX |
| `open` | Your PMX workspace on this Mac, like `flow --web`. `open roadmap` opens your team's roadmap page, the PMs' page in PMX Engine, when `pmx.config.json` has its link. `open studio` opens PMX Engine's studio where it's installed. `--hide-studio` takes the studio out of the nav |
| `flow` | Your workspace: Inbox (tasks to approve), Today, Upcoming, Anytime and Logbook for your to-dos and reviews, then Plan, Digest, Agents, Status (the pipeline, privacy checks, activity) and Settings. `--web` opens it on this Mac; `--install-skill` adds `/pmx-flow`, which publishes the same workspace as a live Claude artifact that works through the Claude app once you click Connect and allow it on your Mac |
| `sources` | Where PMX listens: your meeting apps, recorders you add (`add Momentum`, `add "Google Meet"` for Gemini notes and Meet transcripts through Google Drive, `--only "calls tagged Discovery"`; `remove`), your team's approved channels, and what each may feed (`set granola off`, `mine` for your to-dos only, `linear` for to-dos and team tasks). The board's Sources tab does the same, and proposes team channels |
| `domains` | Your company's email domains, which tell colleagues from customers: `add` or `remove` |
| `categories` | The task categories your agent takes on: `add` or `remove` |
| `whats-new` | What changed in this pmx, or `--since <version>`; PMX also shows it once after every update (`--json` for Claude) |
| `never-ingest` | Your do-not-read list; `add --title`, `--person` or `--channel` adds an entry and says what it would have held; `remove` takes one off |
| `mcp` | The local server the `/pmx-flow` artifact reads through (its only write adds to your do-not-read list); `--install` registers it with the Claude desktop app |
| `claude` | PMX's own Claude profile, which agent runs use: `login` signs it in |
| `explain` | How a run decided: what was found, used, left out, cut and masked, which skills and model ran, why each task got its size, and the cost. `--web` opens a local page |
| `skills` | The Claude skills PMX can use, what each does, when it runs, and whether your team's copy differs from the built-in one |
| `linear` | How PMX reaches Linear: through your Claude app's Linear connector by default (`status`); `written` lists everything PMX wrote there, `tidy` rewrites what older versions wrote (meeting excerpts, meeting titles), `withdraw <id>` cancels an issue and removes its text; `key` stores an API key instead (advanced) |
| `board` | The team board as a live Claude artifact (only when you use Claude and Linear): the link, `--open`, and `--install-skill` for `/pmx-board`, which publishes it from inside the Claude app |
| `schedule` | The scheduled tasks PMX needs in your Claude app and whether each is set up and current; `--install-skill` adds `/pmx-schedule`, which creates or updates them from inside the Claude app; `--allow` lets them run `pmx` without stopping for permission |
| `collect` | Calls and channel threads from your Claude connectors (Granola, Google Meet, Momentum, Slack…): `--prompt` prints the scheduled task's instructions, `--check` validates what it saved and deletes anything from a place your team didn't approve |
| `todo` | Your own to-dos from your meetings, including 1:1s; never leaves your Mac. `--refresh` reads today's unread meetings, `done <id>` checks one off |
| `synthesize` | Today's unprocessed customer calls and approved channel threads → proposed, sized tasks waiting for your approval (`pmx proposals`). A meeting saved by two recorders is read once, and a need already open or waiting gets the new sources instead of a second task |
| `company` | Roll teams' PMX tasks up into company-level themes; reads tasks, never transcripts |
| `pull` | Claim the best ready task that fits the budget and the review cap, and run it (dry run in week one) |
| `claim` / `release` | Claim a specific task; give one back; `--stale` releases expired claims |
| `verify-record` | CI check: every output PR carries a clean run record |
| `vendor` | Put this CLI's package in the PMX repo, so teammates and CI install the same version; `--require` makes it the team minimum, `--auto-update` installs it on every machine by itself |
| `update` | Install your team's version from the PMX repo; `--check` only compares; `--latest` installs the newest public release (for the team lead) |
| `neutrality` | Run skill fixtures in a clean profile; `--compare` two machines' reports |
| `review` | Accept, reject or redo-with-note in the terminal, or `--web` for a local review page; `--stats` for accept rates |
| `login` | Sign in to the free hosted app; creates your team's free org if there isn't one |
| `canvas` | Open the team board: the Claude board if there is one, else the hosted app (free) |
| `analytics` | What this machine sends to your hosted org; `--show` prints the pending events, `on` / `off` |
| `brain` | Free: assess the board and suggest, queue or (on autopilot) take the next actions, each with a reason; `--review` approves what's waiting, `--why` explains the last pass |
| `policy` / `license` | Show the applied admin policy; show or refresh the license that cloud leases need (`ee/`) |
| `tick` | One scheduler pass (launchd runs it every 30 minutes) |
| `uninstall` | Remove the job, profile, keychain items and `~/.pmx` |

## Linear and your Claude app

PMX reaches Linear **through your Claude app** by default, with no API key or sign-in: a scheduled task uses the Linear connector in your Claude app to apply the exact changes PMX queued and bring back the PMX project. PMX checks every result and keeps all the rules in its own code; Claude only carries the changes. Changes reach Linear at the next sync (hourly on weekdays), not instantly. `pmx linear status` shows when it last synced.

### What reaches Linear, and when

- **You approve every task first.** `pmx synthesize` (and the background job) stage proposed tasks in `~/.pmx/staging`. `pmx proposals` shows each one exactly as Linear would get it: title, labels and description, plus, for your eyes only, which meetings it came from and why. Approve one, several or all; drop the rest.
- **Summaries, never transcripts.** A task's description is a short summary in the model's own words, why it got its size, and when its sources were. PMX refuses any description that repeats eight words in a row from a meeting or carries transcript markup like "Microphone:", and drops any cited source the model can't say supports the task.
- **Nothing about meetings goes to Linear.** So no teammate processes a meeting twice, PMX records each processed meeting in your PMX repo (`refs/pmx/meetings`), under an ID keyed with your repo, so nobody outside the team can match it to a meeting by guessing. Versions before 0.16.0 put "Processed meeting" issues in Linear; PMX still recognises them, and `pmx linear withdraw` cancels them.
- **Taking things back.** `pmx linear written` lists everything PMX wrote. `pmx linear tidy` rewrites what versions before 0.14.0 wrote (meeting excerpts in task descriptions, meeting titles on markers). `pmx linear withdraw PMX-12` moves an issue to canceled and replaces its text. Nothing is ever deleted; Linear may keep earlier text in an issue's history, so delete an issue in Linear to remove it completely.

Advanced: `pmx linear key` stores a Linear API key in the keychain, and PMX then talks to Linear directly. The company roll-up needs one, because it reads several projects. Teams on the hosted app use its Linear connection.

### PMX's scheduled tasks

PMX can't create tasks in your Claude app itself, but Claude can. `pmx init` offers to add a `/pmx-schedule` command to your Claude app (or run `pmx schedule --install-skill`). Open the Claude desktop app (Code tab), start a session **with auto mode off** (auto mode can deny the scheduled-tasks tool without saying why), and type `/pmx-schedule`. Claude creates the tasks this machine needs (meeting collection, and the Linear sync), or updates ones with an older prompt. Then click "Run now" on each task once and approve what it asks.

- **Permissions.** A scheduled run stops at any permission prompt nobody answers, and blocks that task's later runs. `pmx init` offers, and `pmx schedule --allow` adds, always-allow rules for PMX's own command and folder (`Bash(pmx *)`, `Read(~/.pmx/**)`, `Edit(~/.pmx/**)`) to your Claude settings. Connectors still ask once, on the first "Run now".
- **This Mac only.** The tasks call `pmx` and write to `~/.pmx`, so they can't run in the cloud.
- **When they run.** Times are your Mac's local time. Tasks run while the Claude app is open and the Mac is awake; a run missed while the app was closed happens once when it opens again.
- **Where to see them.** Claude app → Code tab → Scheduled → the task → Runs. `pmx schedule` and `pmx doctor` say which tasks are missing or out of date, when each last ran, and which ones haven't run or didn't finish. A run that waits for an approval blocks that task's later runs: open it and choose "Always allow".

### The board inside Claude

When your team uses Linear and Claude, `pmx init` also adds `/pmx-board` (or run `pmx board --install-skill`). Type it in the Claude desktop app and Claude publishes the team board as a live artifact in your Claude account: pool → ready → in flight → review → done, read from the PMX project through each viewer's own Linear connector. Everyone works inside Claude, with no hosted app or API key. The board moves cards between the pool and Ready when someone clicks; everything else stays in PMX.

Share it from the artifact's Share menu, then add `"board": { "url": "<link>" }` to `pmx.config.json` in a PR, so every teammate's `pmx canvas` opens the same board. Each viewer allows Linear for the board once.

## Updating

Your team's PMX repo holds the CLI package everyone installs (`.pmx/cli/productmaxxing.tgz`), so a team moves to a new version together. After any update, the first `pmx` command says what's new, once; `pmx whats-new` shows it again.

**Existing machines: what to do**

| This Mac | To update |
|---|---|
| On pmx 0.14.0 or older (named Product Git) | Update as usual below; it just works. Your team's repo and each release carry a bridge copy for older versions; on its first run it swaps the `productgit` npm package for `productmaxxing` and moves your keychain items and background job to their new names. Installing by hand instead? Run `npm uninstall -g productgit` just before the install. |
| On pmx 0.6.0 or later, team has auto-update on | Nothing. The background job installs the team's version within the hour, even when the Claude app is closed, and the next `pmx` command says what's new. |
| On pmx 0.6.0 or later, no auto-update | `pmx update`. It pulls the PMX repo, installs the team's version and prints what's new. |
| Solo, or the team lead, on pmx 0.10.0 or later | `pmx update --latest` installs the newest release after checking its SHA256SUMS. Team lead: then `pmx vendor --require` and merge it. |
| Older than 0.10.0, or installed from a source folder | Install the release once by hand (below), then run `pmx init` again: it keeps your answers and re-registers the background job with the new Node and Claude Code paths. |

Install by hand over an older version (this keeps `~/.pmx`, your settings and keychain items; never run `pmx uninstall` to update):

```bash
d="$(mktemp -d)" && cd "$d"
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.34.0/productmaxxing-0.34.0.tgz
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.34.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
npm uninstall -g productgit   # only if this Mac had Product Git 0.14.0 or older
npm install -g ./productmaxxing-0.34.0.tgz
pmx whats-new --since <the version you had>
```

Updating from 0.24.0 or older? Quit the Claude app completely (⌘Q) and open it again, so it starts PMX's new server: until then your PMX page in Claude talks to the old one. From 0.25.1 the server switches to a new pmx by itself.

Pages you published in Claude with `/pmx-flow` or `/pmx-board` keep running the old code until they're published again: after any update, type `/pmx-flow` (and `/pmx-board`) in the Claude app. Each keeps its link. PMX says so after the update, on the page itself and in `pmx doctor`, and tells Claude too, so a Claude session that ran the update publishes them again itself.

Then run `pmx doctor`. It names anything left to do: for example, `pmx claude login` when PMX's Claude profile isn't signed in, or typing `/pmx-schedule` in the Claude app when a scheduled task's prompt changed.

- **Updating to 0.16.0.** `pmx flow --web` is now the pipeline board, and `/pmx-flow` publishes it: type `/pmx-flow` in the Claude app again to update a page you published. PMX no longer writes "Processed meeting" issues to Linear; `pmx linear written` lists the ones older versions wrote, and `pmx linear withdraw` cancels them.
- **Product Git is now ProductMaxxing (0.15.0).** The `pmx` command, `~/.pmx`, your PMX repo and your settings stay the same. The npm package, the keychain service and the background job have new names (`productmaxxing`, `com.productmaxxing.pmx`); PMX moves them on its first run after the update, and `pmx doctor` warns if anything is left under the old names.
- **Updating to 0.14.0.** Tasks now wait for your approval (`pmx proposals`) instead of going straight to Linear. Run `pmx doctor` afterwards: if it says PMX doesn't know your company's email domain, run `pmx init` again and give it (until then PMX holds every meeting). If it says PMX is paused, your daily cap is $0: `pmx budget off` or `pmx budget set 10`. If older versions already wrote to Linear, check `pmx linear written` and run `pmx linear tidy`. Run `pmx init` again too if doctor says the background job's Node or Claude Code path is gone.
- **No working hours since 0.13.0.** PMX works whenever this Mac is on and awake; your budget still limits it. Hours saved by an older `pmx init` are ignored, so there's nothing to change.
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

- **Clean run profile (B1).** Every run uses `~/.pmx/claude`, `--setting-sources project`, auto memory off, `--strict-mcp-config` with no servers, claude.ai connectors and sync off, reads and writes limited to the repo, the sandbox on and permissions never skipped.
- **Personal-content filter (B2).** Default-deny sources, no DMs, calls only with someone outside your company's email domains (with no domain set, every call is held), and fixed rules that hold back 1:1s (by title, or two people with a title naming two people), hiring and interviews, performance, pay and health. A meeting whose title is about one of those, or that returns to one in two or more passages, is held whole; a single passage is cut. Plus your personal never-ingest list. Held material is discarded, never stored.
- **Nothing in git until approved (B3).** Digests are staged in `~/.pmx/staging` and committed only after the PM approves.
- **Shared team memory (B4).** `memory/` in the PMX repo, loaded through the project `CLAUDE.md`, changed only by code-owner-reviewed PR. Where the team uses PMX Engine, `memory/engine/` holds what the product managers' page shows, put there by the head of product's `/pmxe-memory` pull request; tasks never repeat it word for word. Its `themes.json` lists the open roadmap themes, which PMX suggests on proposals and the PM can apply as Linear labels (`pmx-theme`).
- **Atomic claims.** A claim is a parentless commit pushed to `refs/pmx/claims/<task>`; only one push can win.
- **Provable runs (B5, NEUT-3).** Each output PR carries `.pmx/runs/<task>.json`. CI recomputes the environment fingerprint from the repo and rejects records that don't match.
- **See where data went, and change the rules (FLOW-1 to FLOW-7, BOARD-3).** `pmx flow --web` is the pipeline board on this Mac: counts on every connection from your meeting apps to Linear and back, the skills and scheduled tasks, an audit that checks held meetings against Linear and fake confidential "canary" meetings every run must hold, and every rule, editable. Your own settings apply at once; team settings open one pull request. The `/pmx-flow` artifact is the same workspace in Claude. Before you connect it, it shows counts only: no meeting or proposal titles, no do-not-read entries. Connecting asks you on the Mac; after that, titles reach only your page, uncached, and a Claude chat can't read them or act without the key you allowed (`pmx mcp --unpair` disconnects).
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

Releases: bump the version in `package.json`, `.claude-plugin/plugin.json` and `INSTALL.md`, then push a `v<version>` tag. The release workflow tests, packs and publishes the package with its SHA256SUMS.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a PR. Requirement IDs in comments
(for example `PRIV-4` or `BRAIN-3`) name the product rule a piece of code implements.

The CLI ↔ hosted app contract is in [docs/control-plane-api.md](docs/control-plane-api.md).

## License

Everything outside `ee/` is [Apache-2.0](LICENSE). `ee/` is source-visible under the
[ProductMaxxing Commercial License](ee/LICENSE) and needs a Team plan to use.
