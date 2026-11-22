---
name: pmx-flow
description: Publishes ProductMaxxing's (PMX) workspace as a live Claude artifact (tasks to approve, to-dos, drafts to review, the digest, the pipeline and settings), run on this Mac through the Claude app with nothing in Terminal, or updates the one this Mac already published. Use when the user types /pmx-flow or asks to set up, open or update the PMX workspace, board or flow view in Claude.
---

<!-- Installed by ProductMaxxing (pmx flow --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Publish the PMX workspace

PMX can't publish artifacts itself, so it prepares the page and you publish it.

1. Run `pmx flow --publish-json` in a shell. If `pmx` isn't found, try `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`; if neither exists, tell the user PMX isn't installed and stop.
2. If `ready` is false, tell the user the `reason` and stop.
3. Publish the file at `html` with the Artifact tool. Pass `capabilities`, `icon` and `description` exactly as given; don't add, drop or rename a capability or tool. `capabilities` includes `artifact`: with it the page publishes PMX's newer page over itself after a PMX update, so it needs no /pmx-flow again. If `url` is set, pass it as `url` so the existing page keeps its link (read it first if the tool asks). Don't edit the page. Its content comes from PMX.
4. Run `pmx flow --set-url <the published link>`.
5. Tell the user the link and these facts:
   - The page works on the Mac that opens it, through the Claude desktop app, with nothing running in Terminal. In a browser tab or on another computer it shows how to connect instead.
   - If `mcpInstalled` is false: the user runs `pmx mcp --install` in Terminal once and restarts the Claude app, so the page can reach PMX. Don't run it for them.
   - The first time, the page shows a Connect button. Clicking it makes PMX ask on the Mac, in a dialog, whether to allow the page. After Allow, the page opens on Needs you, every decision waiting for them in one list, and acts on them; their team's work, PMX's health and settings, and their to-dos are in the menu. `pmx mcp --unpair` or Health → Settings → Account disconnects it.
   - The Claude app may ask them to allow some actions the first time.
   - From now on the page updates itself: the first time they open it after PMX updates, it publishes PMX's newer page over itself, with the same link. They need /pmx-flow again only if PMX says so.
   - Every setup step PMX can do itself is a button on the page (Health → Setup); one that changes the background job or the Claude app's settings asks on the Mac first.
6. Never call the `pair`, `board` or `board_act` tools yourself, and never ask the user for a key: they are for the page.

Publish nothing else, never share the page, and never change or delete any other artifact.
