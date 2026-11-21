An enablement schedule read as an agenda: when, what it is, what you will learn, how and with whom.

**Use** `.b-sched` in the enablement chapter, on the `--measure` column. Upcoming sessions first in date order under "Coming up", then past ones newest first under "Earlier". When nothing is planned, show `.none` with a sentence saying who is planning the next session.

**You provide** for each session a `li` with a `time.d` holding the day in `b` and the month in `span`, then `.s` with the title as `h3`, `.teach` (one sentence on what it teaches), and `.meta` with start time, duration, format and "Hosted by" the person in `b`, joined by " · ". Mark the first upcoming session `.is-next` with a `.pill.now` "Next" in its title, and every past session `.is-past`.

- Do write the title as the skill, not the meeting: "Selling offline job packs", not "Sales sync".
- Do say the duration the way people do: "45 min", "1 hour".
- Don't mark more than one session Next.
- Don't hide past sessions. A reader who missed one needs to find the recording.

States: next, upcoming, past, nothing planned.
