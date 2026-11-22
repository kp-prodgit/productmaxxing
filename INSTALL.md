# Install ProductMaxxing (pmx) on a Mac

This guide is written for **Claude Code** to follow on a PM's Mac. To use it, open Claude Code (the Claude desktop app's Code tab, or `claude` in Terminal) and say:

> Install PMX following https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md

The install is one command, `npx --yes productmaxxing@latest install`, then `pmx init`. Installing by hand from the release package (version **0.36.0**, `productmaxxing-0.36.0.tgz` from the [v0.36.0 release](https://github.com/kp-prodgit/productmaxxing/releases/tag/v0.36.0)) is the fallback at the end.

---

## Instructions for Claude

This file gets PMX onto the Mac (steps 0 to 3; step 2 is one command). From step 4 on, **`pmx guide`** and **`pmx checklist`** drive everything: the guide explains what PMX is and how to walk the user through it, and the checklist says what's actually done on this Mac. Follow these steps in order. Report each step's result to the user in one line. Stop at the first step that fails, tell the user what failed and the fix below, and wait for them.

### In short: what you're installing

PMX turns the PM's customer meetings into sized, cited tasks; agents draft them and the PM reviews the drafts. It runs on this Mac:
- a background job that runs every 30 minutes while the Mac is awake;
- Claude app scheduled tasks that collect meetings and sync Linear;
- PMX's page, in Claude or on this Mac.

The PM gates the work:
- the PM approves each new task before anything reaches Linear;
- Start now on a new task makes it Ready for agents at once; tasks approved for later wait in the team's backlog until someone moves them to Ready. A team where a teammate decides what agents take turns Start now off, and then a teammate moves the tasks worth doing to Ready before any agent runs them.

`pmx guide` has the full picture. Read it at step 4, before you explain anything to the user.

### Step 0: auto mode off

Before running anything, tell the user:

> Please switch auto mode off for this session (Shift+Tab until it no longer says auto mode, or pick another mode in the app's mode menu). In auto mode, some install steps get denied without a reason: installing a global npm package, writing to the keychain, registering the background job and creating scheduled tasks. I'll ask before each step instead. Tell me when it's off.

Wait until the user confirms. Do nothing else first.

### Step 1: check this Mac

Run each check and report pass or fail:

| Check | Command | Passes when |
|---|---|---|
| macOS | `uname -s` | prints `Darwin` |
| Node | `node -v` | 22.12 or later in the 22 line, or 24 and up |
| Claude Code | `claude --version`, or `~/.local/bin/claude --version` if `claude` isn't found | prints a version |
| git | `git --version` | prints a version |
| PMX already installed? | `pmx --version` and `command -v pmx` | either answer is fine; note it for "Upgrading" below |

Fixes:
- **Node missing or too old:** suggest `brew install node` (Homebrew installs Node 24), then a new Terminal window. If Homebrew isn't installed, point the user to https://brew.sh. Don't suggest `sudo npm`. A user who prefers nvm can run `nvm install 24 && nvm alias default 24` instead; tell them PMX's background job remembers that Node's folder, so removing that version later breaks the job until they run `pmx init` again. If they install anyway on an older Node, npm stops with the same steps.
- **Claude Code missing:** point the user to https://code.claude.com.
- **Not macOS:** stop. PMX supports macOS only for now.

#### Upgrading an older PMX

If `pmx --version` printed a version, this is an upgrade. Note that version. Follow the same steps, with these differences:
- **Tell the user what's new.** After step 3, run `pmx whats-new --since <the version you noted>` and summarize it for the user in a few lines, with the commands it suggests trying.
- **An old version named Product Git (0.14.0 or older).** Product Git is now ProductMaxxing, and the npm package was renamed from `productgit` to `productmaxxing`. npm won't install the new package over the old one's `pmx` command, so run `npm uninstall -g productgit` just before step 2. This keeps `~/.pmx`, settings and keychain items; the first `pmx` command afterwards moves the keychain items and the background job to their new names.
- **Restart the Claude app before using the PMX page.** The Claude app keeps running PMX's server (`pmx mcp`) with the code it started with, so after an upgrade from 0.24.0 or older the PMX page in Claude talks to the old server until the app restarts. Ask the user to quit the Claude app completely (⌘Q, not just closing its window) and open it again. If you are running inside the Claude app, say this last, since quitting ends this session. `pmx doctor` warns (`flow.mcp-old`) while an old server is still running. From 0.25.1 on, PMX's server switches to a newly installed pmx by itself, and no restart is needed.
- **Publish the user's PMX pages in Claude again, where PMX says so.** A page published with `/pmx-flow` before 0.36.0, or with `/pmx-board` when an update changed the board's page, keeps the code of the pmx that published it until it's published again. A workspace page published with 0.36.0 or later updates itself the next time the user opens it. If `pmx whats-new` ends with "Update your PMX page(s) in Claude", use the `pmx-flow` skill (and `pmx-board`, if it's listed) in this session to publish each one again with the same link. If this session can't publish artifacts, ask the user to type `/pmx-flow` (and `/pmx-board`) in the Claude app.
- **Never run `pmx uninstall`.** It deletes `~/.pmx` (the user's settings, to-dos, collected transcripts, drafts and run receipts), PMX's keychain items and the background job. Installing over the old version keeps all of them.
- **An old copy on a different Node:** if the old `pmx` lives outside the folder `npm prefix -g` prints after any Node change (for example under `~/.nvm/`), it can stay first on PATH. Remove it with the Node it was installed with: `npm uninstall -g productmaxxing`.
- **A folder the old version was built from** (a clone with `npm pack`) isn't used any more. The user can delete it.
- **Step 5 still matters when the checklist asks for it.** `pmx init` offers the saved answers as defaults, so it's quick. It asks again for any saved answer that's now invalid, offers to sign in PMX's Claude profile if it isn't, and registers the background job with the new Node's path and Claude Code's full path. A job from an older version may not find Claude Code at all.
- **Step 6 updates older tasks.** The checklist sends you to `/pmx-schedule`, which updates each task whose prompt changed, creates missing ones and offers the always-allow rules.

### Step 2: install PMX

```bash
npx --yes productmaxxing@latest install
```

It checks the Mac again (macOS, Node, a Node path that stays put), installs PMX where npm can write without `sudo` (npm's own folder when it's writable, otherwise `~/.local`; where PMX is already installed, it stays there), and checks that a new Terminal window finds `pmx`. Read its output to the user in a line or two. Never use `sudo`.

- **"To finish, add this line to ~/.zshrc"** (exit code 3): this session has no terminal for it to ask in, so it changed nothing and printed the one line to add. Ask the user: *"PMX's folder isn't on your PATH yet, so a new Terminal window wouldn't find pmx. May I add it to ~/.zshrc? It's one marked block; nothing else in the file changes."* On yes, run `npx --yes productmaxxing@latest install --yes`: it installs nothing twice, adds the block, and checks again. On no, give them the line.
- **Exit code 0**: installed, and a new Terminal window finds it. **1**: it couldn't install (it says why: not macOS, an old Node, or npm's error). **3**: installed, but a new Terminal window doesn't find `pmx` yet.
- **Joining a team that already uses PMX?** On a Mac that isn't set up yet, this installs the latest release; `pmx init` then joins the team's repo, and the checklist's "PMX is at your team's version" step (`pmx update`) moves it to the team's version. On a Mac already set up, it installs the team's version itself.
- **"Your team names you its product lead"** (only on a Mac already set up with a team that named this user): ask whether to install PMX Engine too, and on yes run `npx --yes productmaxxing@latest install --engine`. See "For your product lead" below. Nobody else is ever asked.
- **If `npx` itself fails** (no network to npm, a company proxy), install by hand instead: "Installing by hand", at the end.

### Step 3: verify

- `zsh -ilc 'pmx --version'` (a fresh login shell, as a new Terminal window starts; this session's own PATH may be older) prints the installed version.
- If plain `pmx` isn't found in this session, run the later steps' commands the same way (`zsh -ilc 'pmx guide'`), or by the full path the install printed. The user's new Terminal windows find it.
- If anything goes wrong later, the step 2 command is safe to run again: on a Mac where everything is in place it changes nothing and says so.

### Step 4: read the guide, and say where the user stands

Run `pmx guide` and read all of it. Then run `pmx checklist --json` and tell the user where they stand, as the guide's "Working through the checklist" section says: what's done, what runs, what's missing, and the next step. On an upgrade, also run `pmx whats-new --since <the version you noted>` and summarize it in a few lines.

### Step 5: `pmx init`, with the user (a new install, or when the checklist asks for it)

`pmx init` asks questions only the user can answer, and reads tokens without showing them. Ask the user to run it themselves in Terminal. Don't run it for them, and never type a token or password for them.

Tell the user beforehand:
- **The PMX repo** holds the team's shared skills, memory and settings. On their own: accept the default, and PMX creates one at `~/pmx`. Joining a team: give the folder where they cloned the team repo.
- **Every answer is checked.** If they paste something by mistake, init asks again. At the end it shows a summary, and nothing is saved until they confirm.
- **Sign in when asked.** PMX runs Claude Code with its own profile, so the user's personal setup never loads, and that profile needs its own sign-in. Init opens the browser for it. Without it, every agent run fails with "Not logged in". `pmx claude login` does it later.
- **Say yes** to:
  - the background job;
  - the `/pmx-schedule` and `/pmx-setup` commands;
  - "Let PMX's scheduled tasks run pmx…". Without this one, scheduled runs stop at permission prompts nobody sees.

### Step 6: work through the checklist

Follow the guide's loop until `pmx checklist --json` has no required step left:
1. Do or hand over the `next` step.
2. Run the checklist again.
3. Report what changed.

That covers:
- the scheduled tasks in the Claude app (`/pmx-schedule`, then Run now and Always allow on each);
- PMX's page and the team board;
- Linear;
- every step an upgrade still needs. `pmx checklist` lists them under "Still to do after updating", for the version this Mac came from.

### Step 7: report

Tell the user:
- the installed version, and for an upgrade, what's new and what the update did (`pmx migrate`);
- where they stand now: the checklist's `where`, what runs and when, and any optional steps left;
- that they can switch auto mode back on now;
- that `/pmx-setup` in the Claude app (or `pmx checklist`) shows where they stand any time;
- that `pmx update` keeps PMX current (and PMX Engine, where it's installed), and that the team lead uses `pmx update --latest` and then `pmx vendor --require`.

---

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

## Installing by hand

The fallback when `npx` can't reach npm. Download the package and its checksum file into a new empty folder, check the checksum, then install:

```bash
d="$(mktemp -d)" && cd "$d"
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.36.0/productmaxxing-0.36.0.tgz
curl -fsSLO https://github.com/kp-prodgit/productmaxxing/releases/download/v0.36.0/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
npm install -g ./productmaxxing-0.36.0.tgz
```

If `shasum` doesn't print `productmaxxing-0.36.0.tgz: OK`, stop and don't install. Tell the user the download didn't match the release.

- **If npm says `EACCES`**, its own folder belongs to the system. Don't use `sudo`. Install into `~/.local` instead, and put its folder on the PATH once:

  ```bash
  npm install -g --prefix ~/.local ./productmaxxing-0.36.0.tgz
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
  ```

  Then open a new Terminal window. `pmx update` keeps using `~/.local` by itself.
- **Joining a team?** Clone the team's PMX repo (ask the team lead for its URL), then `npm install -g <repo>/.pmx/cli/productmaxxing.tgz` (with `--prefix ~/.local` if npm needed it above).
- **Check:** `pmx --version` in a new Terminal window prints `0.36.0`, or the team's version. Then go on with step 4.

## Background for people reading this

- **What gets installed:** one prebuilt package with no runtime dependencies. Installing it downloads nothing else and builds nothing.
- **Node:** 22.12 or later, or 24 or later. Homebrew's `node` is the recommended way to get it.
- **Where things live:**
  - `~/.pmx`: settings, logs, drafts and receipts, private to the user;
  - your PMX repo: shared with the team;
  - the macOS keychain: tokens;
  - one launchd job, `com.productmaxxing.pmx`.
- **Uninstall:** `pmx uninstall`, then `npm uninstall -g productmaxxing` (add `--prefix ~/.local` if PMX is in `~/.local`). Delete the block between `# >>> PMX` and `# <<< PMX <<<` in `~/.zshrc` if the install added one.
