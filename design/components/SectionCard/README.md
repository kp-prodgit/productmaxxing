One section of a document at rest in the studio, in the author's own words, with who sees it said beside the heading.

**Use** `.sec` for each section of vision, value, market size, pricing or enablement while it is not being edited. Not for what a reader receives (use Passage).

**You provide** the heading as `h3` in `.head`, the text in `.body`, and in `.tags` an `.aud.some` when restricted, `.aud.draft` "Draft · nobody sees it" for a draft, and `.pill.held` "Held back" with a `.note` saying who and until when. Add `p.chg` "Changed since edition 1" when it differs from the last release. Put Edit and More, as `.btn.ghost.sm` with their words, in `.act`; they appear on hover and focus, and always on touch. Type choice: the heading uses the briefing passage heading (21/28, 650) and the text the briefing body (17/26) on `--measure`, because `t-title-3` is too small above 17px prose.

- Do show nothing in `.tags` when everyone sees the section.
- Do set `.is-draft` with `.aud.draft`; the dashed edge repeats the words, never replaces them.
- Don't hide the actions from keyboard users; `:focus-within` reveals them.
- Don't colour the text of a changed section; the `today` mark sits beside the words only.

**States:** rest, hover, `.is-selected`, `.is-draft`, changed, held back.
