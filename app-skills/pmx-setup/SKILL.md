---
name: pmx-setup
description: Sets ProductMaxxing (PMX) up in this Claude app in one chat (its scheduled tasks, its page and the team's board, in order, skipping what this Mac already has), and guides the PM through installing, updating and checking PMX from what pmx checklist says is actually done here. Explains where the user stands, what runs and what's missing, and ends with exactly what's left for them. Use when the user types /pmx-setup, asks to set up or finish setting up PMX, asks where they stand with PMX, what's missing, what's running, why nothing happens, or what to do after a PMX update.
---

<!-- Installed by ProductMaxxing (pmx init / pmx checklist --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Set PMX up in one chat, and guide the PM

1. This needs a person at the keyboard. If this session was started by a scheduled task, stop and do nothing else.
2. Run `pmx guide` in a shell and read all of it before you say anything. It's written for you, for the pmx installed on this Mac. If `pmx` isn't found, try `~/.local/bin/pmx`, `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`. If none exists, PMX isn't installed: follow https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md instead (the user runs its one command, `npx --yes productmaxxing@latest install`, in Terminal).
3. Run `pmx setup --prompt` and do what it prints, part by part, in its order. It is the Claude app's part of setup in one chat: PMX's scheduled tasks, then PMX's page, then the team's board, each with that part's own steps for this pmx, and without the parts this Mac already has. Follow what it prints, not your memory of /pmx-schedule, /pmx-flow or /pmx-board: PMX prints the same steps those commands follow, so there is one source. Don't ask the user to type those commands, and don't restart anything, unless it says so. If this pmx has no `setup` command (it's older than this guide), skip this step.
4. Run `pmx checklist --json` and follow the guide's "Working through the checklist" section for whatever is still open: say where the user stands, then do or hand over the `next` step, and run the checklist again after each step. Use the guide's words (its "Words PMX uses": task, backlog, draft, run, page, release, audience), even where a command or field still has an older name.
5. End with exactly what's left for the user, as the last part of `pmx setup --prompt` says: Run now and Always allow on each new or updated scheduled task, and, only if PMX's server is new in the app's settings, quitting and reopening the Claude app once. Say the restart last: quitting ends this chat.
6. Never guess what's set up or running: the checklist says. Never run `pmx init` for the user, never type a token or password, and never run `pmx uninstall`.
