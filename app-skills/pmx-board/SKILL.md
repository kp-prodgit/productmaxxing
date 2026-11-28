---
name: pmx-board
description: Publishes ProductMaxxing's (PMX) team board as a live Claude artifact that reads the team's Linear project through the viewer's own Linear connector, or updates the board this Mac already published. Use when the user types /pmx-board or asks to set up, open or update the PMX board in Claude.
---

<!-- Installed by ProductMaxxing (pmx init / pmx board --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Publish the PMX board

PMX can't publish artifacts itself, so it prepares the page and you publish it.

1. Run `pmx board --json` in a shell. If `pmx` isn't found, try `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`; if neither exists, tell the user PMX isn't installed and stop.
2. If `ready` is false, tell the user the `reason` and stop.
3. If `source` is `"team"`, the team already shares a board. Give the user its `url` and stop, unless they asked you to update it. Only its owner can update it; if a publish is refused because the user can't edit it, say so and stop. Never create a second board.
4. Publish the file at `html` with the Artifact tool. Pass `capabilities`, `icon` and `description` exactly as given; don't add, drop or rename a capability or tool. When `selfUpdate` is true, `capabilities` includes `artifact` and PMX's own server (`host:pmx`, one tool): with them the board publishes PMX's newer board page over itself after a PMX update, so it needs no /pmx-board again. If `url` is set, pass it as `url` so the existing board keeps its link (read it first if the tool asks). Don't edit the page. Its content comes from PMX.
5. Run `pmx board --set-url <the published link>`.
6. Tell the user the link and these facts:
   - Each viewer allows Linear for the board once. The board shows the project through that person's own Linear access.
   - The board changes only one thing in Linear: it moves cards between the backlog and Ready when someone clicks to do it, and Linear's own status moves with them (Backlog, Todo). Moving a task from Backlog to Todo on Linear's own board does the same, so teammates who never open the board can pick work there. Agents, their runs and reviews stay in PMX.
   - Teammates can open it after the user shares it from the artifact's Share menu. To make it the team's board, add `"board": { "url": "<link>" }` to pmx.config.json in a PR.
   - It reads only Linear, so a PMX update doesn't change what it shows.
   - If `selfUpdate` is true: from now on the board updates itself. When a PMX update changes the board's page, the board publishes the newer page over itself, with the same link, the next time the user opens it in the Claude desktop app on this Mac; teammates see it from then on. The Claude app may ask the user once to let the board use PMX. Only the user's own board does this, and only for them; teammates are never asked. They need /pmx-board again only if PMX says so.
   - If `selfUpdate` is false: tell the user the `selfUpdateNeeds` sentence. Until they do that, the board needs /pmx-board again when a PMX update changes its page; PMX says so when one does. Don't run `pmx mcp --install` for them.

Publish nothing else, and never change or delete any other artifact.
