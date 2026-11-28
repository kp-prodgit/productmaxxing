# Install ProductMaxxing (pmx) on a Mac

Four steps and about five questions. You need a Mac with Node 22.12 or later and Claude (the desktop app, with its Code tab). If one is missing, step 1 says so, and "If something's missing" below has the fix.

Installing by hand from the release package (version **0.40.3**, `productmaxxing-0.40.3.tgz` from the [v0.40.3 release](https://github.com/kp-prodgit/productmaxxing/releases/tag/v0.40.3), checked against its checksum) is the appendix at the end.

### Step 1: one command in Terminal

Open Terminal and run:

```bash
npx --yes productmaxxing@latest install
```

It checks the Mac, installs PMX where npm can write without `sudo`, makes sure a new Terminal window finds `pmx`, and goes straight on to setting PMX up (`pmx init`), in the same window.

Joining a team? Your team lead can give you the command with your team's repo in it, and then setup doesn't ask where it is:

```bash
npx --yes productmaxxing@latest install --repo <your team's PMX repo: its git URL>
```

### Step 2: answer its few questions

Setup asks only what PMX can't work out itself.

| You are | It asks | Questions |
|---|---|---|
| **Joining a team** | Where your team's PMX repo is: its git URL (PMX clones it into `~/pmx`), or the folder you cloned it to. Then one yes. On a Linear team, your Linear API key last. | 3 at most; 2 with `--repo` or when PMX finds your clone |
| **Starting a team, or on your own** | Return for a new repo in `~/pmx`, your team's name, its Linear team and its Linear project (blank for none yet). Then one yes, and with a Linear project your Linear API key. | 6 at most |

**Your Linear API key** (Linear teams only). PMX reaches Linear with your own key, so what you approve gets there at once and PMX sees your team's changes within the half hour. Setup says this before it asks:

1. In Linear, open Settings → Account → Security & access → Personal API keys → New API key.
2. Permissions: **Read** and **Write**. Not Admin and not full access; "Create issues" and "Create comments" alone aren't enough.
3. Team access: **only the team that holds your PMX project** (setup names it). On the Mac that runs your company's roll-up, also Read on the teams it reads (setup names those too).
4. Paste the key at "Linear API key". It isn't shown. PMX checks it with one read and says whose it is and what it reaches ("Linear key for Sam Lee: can read and write Acme Product's PMX project"; on a team whose PMX labels all exist already it can only show the read, and says its first change will show the rest). Then it keeps the key in the macOS keychain only. A key that can't see the project, or can't write, is refused with what's missing, and you can paste another.

Can't create one (your workspace's admins can turn member keys off), or would rather not? Press **Return**: PMX then goes through your Claude app's Linear connector, once an hour, and doesn't ask again. `pmx linear key` changes it later, either way.

Three more can come up, each only when PMX can't answer it for you:
- **your PATH**, before setup starts: "Add … to your PATH in ~/.zshrc?", when a new Terminal window wouldn't find `pmx` otherwise;
- **your company's email domain**, when neither your team's settings nor your git email says it;
- **a GitHub token**, when your team's repo is on GitHub and `gh` isn't signed in on this Mac. You type it into PMX's own prompt, it isn't shown, and it goes to the macOS keychain only. Blank skips it.

Everything else PMX works out and shows you before you say yes: your handle (your Mac's account name), your Claude plan (from Claude Code's sign-in where it says, otherwise Team), every kind of work your team has, no spend cap of your own on a Claude plan, PMX's own transcripts folder and an empty do-not-read list. To be asked about each instead, run `pmx init --ask`; to change one later, PMX's page (Health → Settings) or `pmx init --ask` again.

**The one yes.** Before it saves anything, setup lists what it will change outside its own folder (`~/.pmx`), each with what it changes and where:

1. **Background job**: registers the launchd job `com.productmaxxing.pmx` in `~/Library/LaunchAgents`, which runs PMX every 30 minutes while this Mac is awake.
2. **Claude commands**: adds `/pmx-setup`, `/pmx-schedule`, `/pmx-flow` and, for a team on Linear, `/pmx-board` to your Claude app's own commands (`~/.claude/skills`).
3. **Allow rules**: adds `Bash(pmx *)`, `Read(~/.pmx/**)` and `Edit(~/.pmx/**)` to your Claude settings (`~/.claude/settings.json`), so PMX's scheduled tasks don't stop at a permission prompt nobody sees.
4. **PMX's server**: adds PMX's server to the Claude desktop app's settings, so PMX's page there works on this Mac. Any Claude chat on this Mac can then read PMX's counts, never meeting or task titles, and add to your do-not-read list.

Answer `yes` for all of them, `pick` to choose each one, or `no` to save nothing at all. Nothing on the list happens without your yes, and each has its own command for later. Then your browser opens once to sign in PMX's own Claude profile: PMX runs Claude Code with a profile of its own, so your personal setup never loads in its runs.

### Step 3: restart Claude and type /pmx-setup

Quit the Claude app completely (⌘Q) and open it again, once: it then has PMX's commands and starts PMX's server. In its Code tab, type:

```
/pmx-setup
```

In that one chat Claude creates PMX's scheduled tasks (meeting collection; and the Linear sync only on a Mac where you pressed Return at the Linear key), publishes PMX's page, and publishes your team's board when your team has one, in that order, skipping whatever this Mac already has. If the session is in auto mode, Claude asks you to switch it off first: auto mode can deny creating scheduled tasks without saying why.

### Step 4: Run now and Always allow

Claude ends the chat with exactly what's left for you: in the Claude app, Code tab → Scheduled, open each PMX task, click **Run now** once, and choose **Always allow** for what it asks (its connector). Until you do, that task's later runs wait for an approval nobody sees.

That's all. PMX works while this Mac is awake (meeting collection also needs the Claude app open), so keep a laptop plugged in during work hours. With your Linear API key PMX has read your team's project already and syncs with every background run; without one, its first sync through the Claude app runs at the top of the hour. `/pmx-setup` in the Claude app, or `pmx checklist` in Terminal, says where this Mac stands any time.

---

## If something's missing

- **Node is missing or too old** (step 1 says "PMX needs Node 22.12 or later", or `npx` isn't found): `brew install node` (Homebrew installs Node 24), then a new Terminal window, then step 1 again. If Homebrew isn't installed, see https://brew.sh. Don't use `sudo npm`. With nvm instead, `nvm install 24 && nvm alias default 24` works, but PMX's background job remembers that Node's folder, so removing that version later stops the job until you run `pmx init` again.
- **Claude Code is missing** (setup says "Claude Code was not found"): install it from https://code.claude.com, then run `pmx init` again.
- **Not macOS:** PMX supports macOS only for now.
- **You said no to the PATH question, or your shell isn't zsh or bash:** step 1 prints the one line to add to your shell's startup file. Add it, open a new Terminal window, and run `pmx init`.
- **Setup stopped, or you answered `no`:** run `pmx init` again. It's safe to run again: it asks nothing it already knows and changes nothing that's in place.
- **You left something off the list at the one yes:** each has its own command.

  | Left out | Later |
  |---|---|
  | Background job | `pmx init` again, or **Turn on automatic runs** on PMX's page |
  | Claude commands | `pmx checklist --install-skill` (and `pmx schedule --install-skill`, `pmx flow --install-skill`, `pmx board --install-skill`) |
  | Allow rules | `pmx schedule --allow` |
  | PMX's server | `pmx mcp --install`, then quit and reopen the Claude app |

- **`/pmx-setup` isn't among Claude's commands:** run `pmx checklist --install-skill`, then quit the Claude app (⌘Q) and open it again.
- **"Linear no longer accepts this Mac's API key":** the key was revoked in Linear, or its access changed. Nothing reaches Linear until you run `pmx linear key` in Terminal and paste a new one (it says where to create it), or go back to the Claude app's hourly sync with `pmx linear key --remove` and then `/pmx-schedule` in the Claude app. PMX never switches by itself.
- **Your workspace doesn't let members create API keys:** press Return at the question (or run `pmx linear key` and press Return). PMX uses your Claude app's Linear connector instead, and `/pmx-setup` creates its hourly sync task. An admin can allow member keys in Linear under Settings → Administration → API.
- **Claude can't create scheduled tasks or publish pages in that session:** start a new session in the Code tab with auto mode off and type `/pmx-setup` again. Each part also has its own command: `/pmx-schedule` (the tasks), `/pmx-flow` (PMX's page), `/pmx-board` (the team board). Without any of them, `pmx schedule` prints a request to paste into Claude.
- **Your team is on another PMX version than the one step 1 installed:** step 1 installs the latest release on a Mac that isn't set up yet, and setup then joins your team's repo. The checklist's "PMX is at your team's version" step (`pmx update`) moves this Mac to your team's version. On a Mac already set up, step 1 installs your team's version itself.
- **`npx` can't reach npm** (no network to npm, a company proxy): install by hand, in the appendix.
- **Anything else:** `pmx checklist` lists every step with what's true now and the exact next action, and `pmx doctor` has the detail.

## If you are Claude, helping someone install

A person can also start in Claude Code, by saying "Install PMX following https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md". Then you are reading this. The steps above are the person's: setup asks questions only they can answer, reads tokens without showing them and opens their browser, so it needs their own Terminal.

- **Ask the user to do step 1 themselves, in Terminal.** Give them the one command. Never run `pmx init` for them, and never type a token or password.
- **If they want you to install it:** ask first, and ask them to switch auto mode off for this session (in auto mode, installing a global npm package can be denied without a reason). From your session `npx --yes productmaxxing@latest install` has no terminal, so it installs PMX, never starts setup, and changes no PATH:
  - **exit code 0**: installed, and a new Terminal window finds it;
  - **1**: it couldn't install (it says why: not macOS, an old Node, or npm's error);
  - **3**: installed, but a new Terminal window doesn't find `pmx` yet. When it printed "To finish, add this line to ~/.zshrc", ask: *"PMX's folder isn't on your PATH yet, so a new Terminal window wouldn't find pmx. May I add it to ~/.zshrc? It's one marked block; nothing else in the file changes."* On yes, run `npx --yes productmaxxing@latest install --yes`: it installs nothing twice, adds the block, and checks again. On no, give them the line.

  Never use `sudo`. Then the user runs `pmx init` in Terminal (step 2).
- **Check it:** `zsh -ilc 'pmx --version'` (a fresh login shell, as a new Terminal window starts; this session's own PATH may be older) prints the installed version. If plain `pmx` isn't found in this session, run later commands the same way (`zsh -ilc 'pmx guide'`), or by the full path the install printed.
- **Before you explain anything, run `pmx guide` and read all of it.** It says what PMX is, what runs where, and your rules. Then `pmx checklist --json` says what's actually done on this Mac: tell the user where they stand, as the guide's "Working through the checklist" section says.
- **Step 3 is yours when the user types `/pmx-setup`** (or asks you to finish setting PMX up): `pmx setup --prompt` prints every part of it in order, without the parts this Mac already has. Follow it, and end with what it says is left for the user.
- **"Your team names you its product lead"** (only on a Mac already set up, for the user the team named): ask whether to install PMX Engine too, and on yes run `npx --yes productmaxxing@latest install --engine`. See "For your product lead" below. Nobody else is ever asked.
- **Report** the installed version, where they stand (the checklist's `where`, what runs and when, any optional steps left), that `/pmx-setup` or `pmx checklist` shows it any time, and that PMX keeps itself current: the background job installs the version their team's repo carries within the hour of a merge, unless the team turned that off (`"cli": { "autoUpdate": false }`) or the repo carries no PMX package. `pmx update` does it at once (and updates PMX Engine, where it's installed, which the background job never does), and the team lead moves the team with `pmx update --latest` and then `pmx vendor --require`.

## Upgrading an older PMX

If `pmx --version` prints a version, this is an upgrade. Note that version. PMX updates itself from your team's repo unless your team turned that off, and `pmx update` does it at once; to move an older Mac by hand, run the step 1 command, which installs over the old version and keeps everything. Then:
- **Tell the user what's new.** After the install, run `pmx whats-new --since <the version you noted>` and summarize it for the user in a few lines, with the commands it suggests trying.
- **An old version named Product Git (0.14.0 or older).** Product Git is now ProductMaxxing, and the npm package was renamed from `productgit` to `productmaxxing`. npm won't install the new package over the old one's `pmx` command, so run `npm uninstall -g productgit` just before step 1. This keeps `~/.pmx`, settings and keychain items; the first `pmx` command afterwards moves the keychain items and the background job to their new names.
- **Restart the Claude app before using the PMX page.** The Claude app keeps running PMX's server (`pmx mcp`) with the code it started with, so after an upgrade from 0.24.0 or older the PMX page in Claude talks to the old server until the app restarts. Ask the user to quit the Claude app completely (⌘Q, not just closing its window) and open it again. If you are running inside the Claude app, say this last, since quitting ends this session. `pmx doctor` warns (`flow.mcp-old`) while an old server is still running. From 0.25.1 on, PMX's server switches to a newly installed pmx by itself, and no restart is needed.
- **Publish the user's PMX pages in Claude again, where PMX says so.** A page published with `/pmx-flow` before 0.36.0, or with `/pmx-board` when an update changed the board's page, keeps the code of the pmx that published it until it's published again. A workspace page published with 0.36.0 or later updates itself the next time the user opens it. If `pmx whats-new` ends with "Update your PMX page(s) in Claude", use the `pmx-flow` skill (and `pmx-board`, if it's listed) in this session to publish each one again with the same link. If this session can't publish artifacts, ask the user to type `/pmx-flow` (and `/pmx-board`) in the Claude app.
- **Never run `pmx uninstall`.** It deletes `~/.pmx` (the user's settings, to-dos, collected transcripts, drafts and run receipts), PMX's keychain items and the background job. Installing over the old version keeps all of them.
- **An old copy on a different Node:** if the old `pmx` lives outside the folder `npm prefix -g` prints after any Node change (for example under `~/.nvm/`), it can stay first on PATH. Remove it with the Node it was installed with: `npm uninstall -g productmaxxing`.
- **A folder the old version was built from** (a clone with `npm pack`) isn't used any more. The user can delete it.
- **`pmx init` still matters when the checklist asks for it.** On a Mac that's set up it asks nothing it already knows: only about a saved answer that's now invalid, and one yes if something outside `~/.pmx` needs changing, such as the background job after Node moved (it registers the job with the new Node's path and Claude Code's full path; a job from an older version may not find Claude Code at all). It signs in PMX's Claude profile if it isn't.
- **Older tasks are updated in the Claude app.** The checklist sends you to `/pmx-schedule` (or `/pmx-setup`, which does it with the rest), which updates each task whose prompt changed, creates missing ones and offers the always-allow rules.

## For your product lead

PMX is for every PM. PMX Engine (`pmxe`, npm `pmx-engine`) is only for your team's product lead, who uses it to tell each audience what it needs to know. Your team names its product lead in its settings (`"productLead": "<their PMX handle>"` in `pmx.config.json`, or Health → Settings → Account on PMX's page), reviewed like every other team setting.

- **The product lead** is asked during the install whether to add PMX Engine too ("Install PMX Engine too?", no unless they say yes; `--yes` never means Engine). Later, the checklist's **Install PMX Engine** step does the same, with a button on PMX's page.
- **To install it on purpose**, for example while your team changes product lead:

  ```bash
  npx --yes productmaxxing@latest install --engine
  ```

  It installs `pmx-engine` in the same folder as PMX and shows Engine's next step. Engine's own setup is guided from there: `pmxe guide` for Claude, `pmxe checklist` for where it stands. It never opens the studio for you.
- **Everyone else** is never asked about PMX Engine, and their checklist says it's the product lead's tool.
- **Updates:** `pmx update` updates PMX Engine too, with Engine's own updater. It doesn't update Engine while a release is being sent, and says so.

## Appendix: installing by hand, verified

The fallback when `npx` can't reach npm, and the way to install a package you checked yourself. Download the package and its checksum file into a new empty folder, check the checksum, then install:

```bash
d="$(mktemp -d)" && cd "$d"
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.40.3/productmaxxing-0.40.3.tgz
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.40.3/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
npm install -g ./productmaxxing-0.40.3.tgz
```

If `shasum` doesn't print `productmaxxing-0.40.3.tgz: OK`, stop and don't install. Tell the user the download didn't match the release.

- **If npm says `EACCES`**, its own folder belongs to the system. Don't use `sudo`. Install into `~/.local` instead, and put its folder on the PATH once:

  ```bash
  npm install -g --prefix ~/.local ./productmaxxing-0.40.3.tgz
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
  ```

  Then open a new Terminal window. `pmx update` keeps using `~/.local` by itself.
- **Joining a team?** Clone the team's PMX repo (ask the team lead for its URL), then `npm install -g <repo>/.pmx/cli/productmaxxing.tgz` (with `--prefix ~/.local` if npm needed it above).
- **Check:** `pmx --version` in a new Terminal window prints `0.40.3`, or the team's version. Then run `pmx init` in Terminal (step 2 above) and go on from there.

## Background for people reading this

- **What gets installed:** one prebuilt package with no runtime dependencies. Installing it downloads nothing else and builds nothing.
- **Node:** 22.12 or later, or 24 or later. Homebrew's `node` is the recommended way to get it.
- **Where things live:**
  - `~/.pmx`: settings, logs, drafts and receipts, private to the user;
  - your PMX repo: shared with the team;
  - the macOS keychain: tokens;
  - one launchd job, `com.productmaxxing.pmx`.
- **Uninstall:** `pmx uninstall`, then `npm uninstall -g productmaxxing` (add `--prefix ~/.local` if PMX is in `~/.local`). Delete the block between `# >>> PMX` and `# <<< PMX <<<` in `~/.zshrc` if the install added one.
