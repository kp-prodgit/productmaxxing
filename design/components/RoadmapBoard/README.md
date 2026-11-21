The roadmap as a board: themes down the side, Now, Next and Later across, every entry with its window and how sure we are, in words.

**Use** `.b-road` as the body of the roadmap chapter, up to `--measure-wide`. Under 640px it stacks by theme, lane labels beside entries. When nothing is on the roadmap, show `.empty` instead of an empty table.

**You provide** a `table` with an `sr-only` caption summarising it (themes, lanes, counts, changes); lane heads with their quarters in `small`; per theme a row header with `.tt` title, `.own` "Led by" and a person, optional `.tags`; per lane a `td` with `data-lane`, empty when the lane is empty. Each entry is `.it`: `.n` name with `.mark` New or Updated, then `.meta` with the window and `.conf` `.committed`, `.likely` or `.exploring`. When some entries have approved wording, add `.lens` and a "What you can tell customers" view: entries show only the name and the wording in `q`; entries without wording, and themes left empty, are absent.

- Do keep confidence as the word. The filled, half and hollow mark repeats it.
- Do leave an empty lane empty. A dash or "None" is ink on the normal case.
- Don't show windows or confidence in the customer view.

States: everything, customer view, sparse, new or updated entry, stacked.
