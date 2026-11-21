The bar that stays at the top of a briefing: who it is for, the chapters as words, and the vertical when there is more than one.

**Use** `.b-nav` once per briefing page, above the cover. Never in the studio or the Workspace, which have their own rail. Under 600px the chapters become one row that scrolls sideways.

**You provide** the team name in `b` and the audience ("For Sales") in `.who`; the chapters as links in `ul.ch`, in the author's order, with `aria-current="page"` on the one being read; and, only when the page covers several verticals, `.vert` as a `role="group"` of real buttons with `aria-pressed`, labelled by what they switch ("Market").

- Do name chapters the way the reader says them: "Market size", not "TAM/SAM/SOM".
- Do list only chapters that have something released. Unreleased ones belong in the summary's last line, not as dead links.
- Don't show `.vert` with one option. One vertical is the page, not a choice.
- Don't add counts, dots or colour to chapter names. A changed chapter says so in its cover's change list.

States: rest, current chapter (weight and underline), hover, focus, vertical pressed, vertical disabled, scrolling row under 600px.
