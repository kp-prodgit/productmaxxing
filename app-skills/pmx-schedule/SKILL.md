---
name: pmx-schedule
description: Sets up ProductMaxxing's (PMX) scheduled tasks in this Claude app. Asks pmx which tasks this machine is missing or has with an older prompt (meeting collection, the Linear sync) and creates or updates each one with the scheduled-tasks tool. Use when the user types /pmx-schedule or asks to set up or fix PMX's Claude tasks.
---

<!-- Installed by ProductMaxxing (pmx init / pmx schedule --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->

# Set up PMX's scheduled tasks

PMX can't create tasks in this app itself, so it lists what this machine needs and you create them.

0. This needs a person at the keyboard. If this session was started by a scheduled task, stop: say PMX's tasks must be set up from a live session, and do nothing else. If the session is in auto mode, ask the user to switch auto mode off for this session (it can deny the scheduled-tasks tool without saying why), and wait until they say it's off.
1. Run `pmx schedule --json` in a shell. If `pmx` isn't found, try `/opt/homebrew/bin/pmx` and `/usr/local/bin/pmx`; if neither exists, tell the user PMX isn't installed and stop.
2. For each entry in `missing`, create a scheduled task with exactly its `taskId`, `title`, `description`, `cronExpression` and `prompt`. Don't reword the prompt or change the schedule.
3. For each entry in `outdated`, update the existing task with that `taskId` so its prompt and description are exactly the given `prompt` and `description`. If the entry's `reschedule` is true, the task still has an older schedule PMX gave it (from 0.36.0 the tasks run every day, and PMX itself stops a run outside the user's working hours), so also set its schedule to `cronExpression`. Change nothing else about it.
4. Create or update nothing that isn't in `missing` or `outdated`, and never change or delete any other scheduled task.
5. If `allowRulesMissing` isn't empty, explain that scheduled runs stop at permission prompts nobody answers, and ask whether to run `pmx schedule --allow`, which adds always-allow rules for PMX's own command and its ~/.pmx folder to the user's Claude settings. Run it only if they say yes.
6. Run `pmx schedule` and show the user what it prints.
7. Tell the user:
   - Open each new or updated task under Scheduled, click "Run now" once and approve what it asks (choose "always allow" for the connector), so later runs don't stop for permission.
   - The tasks run on this Mac only, because they call `pmx` and write to ~/.pmx. Don't move them to the cloud.
   - Times are this Mac's local time, and tasks run while the Claude app is open. Each task's run history is under Code tab → Scheduled → the task → Runs.
   - Their working hours are PMX's own setting (PMX's page: Health → Settings → Schedule). Outside them each run starts briefly and stops, and changing them needs no /pmx-schedule.

If `missing` and `outdated` are both empty, say every PMX task is already set up.
