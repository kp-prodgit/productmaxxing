A numbered section heading with a short brand bar in the margin, and the plain sub-heading that divides a section.

**Use** `.rp-h` (an `h2`) for each numbered section of a report: the overview, one per chapter, and the appendix (unnumbered, "Appendix A: …"). Use `.rp-h2` (an `h3`) for the parts inside a section. Do not use either outside `.rp`; `--brand` lives there.

**You provide** the number in `.no` with its full stop, the section name, and optionally `.ed`, a caption line naming the editions and dates the section is drawn from. A sub-heading may carry a `.mark` New or Updated when the part changed since the reader's last edition.

- Do number sections in reading order, starting with 1 for the overview.
- Do keep a heading on the same sheet as what follows it; the paginator treats both levels as keep-with-next.
- Don't add a bar to sub-headings; one bar per section keeps the page calm.
- Don't put state in the heading text; marks say New or Updated in words.

States: section, section with edition line, sub-heading, sub-heading with mark.
