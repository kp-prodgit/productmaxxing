---
name: pmx-setup
description: Guides the PM through installing, setting up, updating and checking ProductMaxxing (PMX) on this Mac, step by step, from what pmx checklist says is actually done here. Explains what PMX is, where the user stands, what runs and what's missing, and does or hands over each next step. Use when the user types /pmx-setup, asks where they stand with PMX, what's missing, what's running, why nothing happens, or what to do after a PMX update.
---

<!-- Installed by ProductMaxxing (pmx init / pmx checklist --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Guide the PM through PMX

1. This needs a person at the keyboard. If this session was started by a scheduled task, stop and do nothing else.
2. Run `pmx guide` in a shell and read all of it before you say anything. It's written for you, for the pmx installed on this Mac. If `pmx` isn't found, try `~/.local/bin/pmx`, `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`. If none exists, PMX isn't installed: follow https://github.com/kp-prodgit/productmaxxing/blob/main/INSTALL.md instead (its one command is `npx --yes productmaxxing@latest install`).
3. Run `pmx checklist --json` and follow the guide's "Working through the checklist" section: say where the user stands, then do or hand over the `next` step, and run the checklist again after each step. Use the guide's words (its "Words PMX uses": task, backlog, draft, run, page, release, audience), even where a command or field still has an older name.
4. Never guess what's set up or running: the checklist says. Never run `pmx init` for the user, never type a token or password, and never run `pmx uninstall`.
