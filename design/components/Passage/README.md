A numbered section of a briefing. The number is how people refer to it in a meeting: "look at three".

**Use** one per section, in the author's order. Numbers are stable within an edition and each passage has an `id` to link to.

**You provide** the number, the heading, an optional `.mark` (New or Updated since the last edition), and the body: paragraphs in `b-body`, a figure, a board, or a `.say` block. `.say` holds wording the reader may repeat, quoted exactly; `.say.dont` holds what must not be said.

- Do keep the measure: text never runs wider than `measure`.
- Do put what the reader may repeat in `.say`, so it can be found at a glance before a customer call.
- Don't nest cards inside a passage. The rule between passages is the only divider.
- Don't mark everything New on a first edition.
