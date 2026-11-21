A group of things the person can open, each on one quiet row.

**Use** `.group` with a `.gh` heading and a list of `.row` items for sections, proposals, editions and anything else the person scans and picks from. Use Table instead when the reader compares values across columns.

**You provide** a heading `h2` in `.gh`, an optional count in `.c` and a right slot `.r` for one quiet button. Each `.row` takes a leading slot `.lead` (an icon or a check), the title `.t` (an `a` makes the whole row the target), an optional meta line `.m` and a trailing slot `.acts` holding at most one button, or an `.aud` chip. Mark the open row `.sel` or `aria-current="true"`, and finished ones `.done`.

- Do write the meta line as a short fact with a name and a date: "Edited today by Priya Nair".
- Do keep at most one filled button in a group, on the row that is the next step.
- Don't put a pill on every row. Only the rows that differ carry one.
- Don't add a second line just to fill space; a row without meta is 36px and that is fine.

States: rest, hover (`hover`), selected (`select`), focus-visible (inset ring), done (struck through with a check), disabled. 44px tall under 768px.
