The executive overview: one line per released chapter, saying the takeaway, its edition and whether it changed. It replaces the grid of chapters by groups.

**Use** `.b-summary` at the top of the ELT page, under the cover. Use it wherever a reader needs the whole picture before choosing a chapter.

**You provide** an `h2` that says whose summary it is, then an `ol` with one `li` per released chapter, in reading order: the chapter name as `a.nm` to the chapter, its takeaway as `.tk` (the chapter's standfirst, one sentence), and `.ed` with "Edition 2 · 20 Nov" and a `.mark` New or Updated when it changed since the last edition. A chapter whose takeaway is held back gets `.is-held` and the line "Being revised since 14 Nov. Do not quote it." Close with one `.rest` line naming every chapter with nothing released: "Not released yet: Value, Pricing, Enablement".

- Do write the takeaway as a sentence a person could repeat in a meeting.
- Do say unreleased chapters once, in `.rest`. Never as a repeated cell.
- Don't show release progress here. Where a release has reached belongs to the author's track.
- Omit `.rest` when everything is released.

States: rest, changed, held back, nothing released (only `.rest`).
