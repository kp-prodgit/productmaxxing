The roadmap as theme columns of entry cards, which the author arranges by dragging or from the keyboard.

**Use** `.canvas` for the roadmap in the studio. It scrolls sideways inside itself; the page never does. Not for a reader's roadmap page.

**You provide** `.cols` of `.theme` columns, each with a `header` (`h3`, `.by` "Owned by Omar Haddad", `.aud.some` only when restricted), a `.list` of entries and an `.add` button "Add entry". End with `.theme.unsorted` for entries without a theme, saying what to do with them. Each `.entry` has a `.name` button that opens it, a `.grip` button that moves it, a `.meta` line with the window (`.when`, "Q2 27") and `.conf` (icon and word: Committed, Likely, Exploring), and `.tags` for `.aud.some`, `.may` "Sales may say this", `.pill.draft` and `.chg`.

- Do give the grip an accessible name and describe the keys with `aria-describedby`.
- Do show `.hint` "Arrows move it. Space drops it. Escape cancels." on the card while it is lifted from the keyboard, not in a tooltip.
- Do mark where a dragged entry lands with `.slot` and words: "Move here, after Shared site templates".
- Don't rotate a dragged card; it lifts with `--shadow` only.

**States:** rest, hover, `.is-selected`, `.is-dragging`, drop target, `.is-lifted`, `.is-draft`, empty column (`.none`).
