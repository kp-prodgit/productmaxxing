---
name: pmx-flow
description: Publishes ProductMaxxing's (PMX) pipeline board as a live Claude artifact (skills, scheduled tasks, what travels from meeting apps and Slack to Linear and back, and the rules behind each step), read from PMX on this Mac, or updates the one this Mac already published. Use when the user types /pmx-flow or asks to set up, open or update the PMX flow view in Claude.
---

<!-- Installed by ProductMaxxing (pmx flow --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Publish the PMX pipeline board

PMX can't publish artifacts itself, so it prepares the page and you publish it.

1. Run `pmx flow --publish-json` in a shell. If `pmx` isn't found, try `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`; if neither exists, tell the user PMX isn't installed and stop.
2. If `ready` is false, tell the user the `reason` and stop.
3. Publish the file at `html` with the Artifact tool. Pass `capabilities`, `icon` and `description` exactly as given; don't add, drop or rename a capability or tool. If `url` is set, pass it as `url` so the existing page keeps its link (read it first if the tool asks). Don't edit the page. Its content comes from PMX.
4. Run `pmx flow --set-url <the published link>`.
5. Tell the user the link and these facts:
   - The page reads PMX on the Mac that opens it, through the Claude desktop app. It shows nothing in a browser tab or on another computer.
   - If `mcpInstalled` is false: the user runs `pmx mcp --install` in Terminal once and restarts the Claude app, so the page can reach PMX. Don't run it for them.
   - The page shows counts only: no meeting or proposal titles and no do-not-read entries. `pmx flow --web` shows those on the Mac, and that's where the user approves proposed tasks and changes rules.
   - The page changes one thing: it adds an entry to the user's do-not-read list when they click to.

Publish nothing else, never share the page, and never change or delete any other artifact.
