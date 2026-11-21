The table a report argues with: an ink header row, a bold first column, faint zebra rows and hairlines, with comparison and appendix variants.

**Use** `.rp-tbl` around a `table` inside `.rp` whenever the reader compares across rows: chapters, plans, figures and their basis, roadmap entries by theme (`tr.is-group` rows name the theme). Use `.cmp` for last edition against this edition, and `.appx` for the dense dated list of everything in the report.

**You provide** an optional `.cap` line above the table, `th scope="col"` heads, `th scope="row"` first cells, `.n` on numeric columns, and `tr.is-total` for a closing total. In `.cmp`, the earlier value takes `.was` and the new one `.is-changed`, set in weight. In `.appx`, dates take `.d`.

- Do let the paginator split long tables between rows; it repeats the header row and keeps a total with the row above.
- Do say what changed in words ("Q2 27 · Likely", "New section"); weight marks it, colour never does.
- Don't put more than five columns on a sheet.
- Don't use it for a single fact per row; that is a paragraph.

States: summary with total, group rows, comparison, appendix.
