The control that sets who sees a section, with every group named in full and a sentence that says what the choice means.

**Use** `.audp` wherever an author sets a section's or an entry's audience: in the section editor, the entry panel, the new section dialog. Not to show an audience at rest (use `.aud`).

**You provide** a `.lbl` naming the section, then `.opts` with "Everyone" first, the groups, and "Draft · nobody sees it yet" last, each a `label.opt` holding a real checkbox, `.box`, `.name` and an optional `.why`. Mark the first group and the draft row `.split`. New sections start on Draft. Under the list, `.sum` is the live sentence ("ELT and Engineering will see this. Marketing and PMM, Sales and Rest of GTM will not."), and `.wider` appears before saving when the choice widens something already released.

- Do write the reason a group is off in `.why`, linked with `aria-describedby`: "No page yet. Set one up in Settings."
- Do keep `.sum` in an `aria-live="polite"` region so it is heard as it changes.
- Don't abbreviate groups or give them colours.
- Don't save a widening silently; `.wider` names the groups who will see it for the first time.

**States:** draft (default), some groups, everyone, a group disabled, widening.
