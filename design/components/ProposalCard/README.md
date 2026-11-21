Something Claude or PMX suggests adding or changing, with the evidence for it, which the author accepts or drops.

**Use** `.prop` inside a `.props` list wherever proposals arrive: after Ask Claude, a library build, roadmap suggestions or a tracker change. Not for the author's own drafts.

**You provide** once at the top of the list a `.note`: "Nothing here changes Vision until you accept it." Each card has a `.top` with the `.by` chip ("Proposed by Claude" with the spark, or `.by.pmx` "Proposed by PMX") and a `.where`, a `.what` with `.kind`, `h3` and the text in the author's terms, a `blockquote` with the evidence and a `cite` naming the source document, and `.act` with Accept and Drop.

- Do say what changes in the author's nouns: "A change to Plan a job offline", not a file or an ID.
- Do name the source document and who wrote it in `cite`.
- Don't repeat "changes nothing until accepted" on every card.
- Don't make Accept a filled button; many cards share a screen.
- After a choice, replace the body with `.res`: the name, `.pill.ok` "Added as a draft" or `.pill` "Dropped", and Undo.

**States:** waiting, accepted (`.is-done`), dropped (`.is-done.is-dropped`).
