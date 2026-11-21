What a release will change, said in words before it happens. It is the body of the release dialog.

**Use** `.relsum` inside the release dialog, above the button "Release edition 2". Never label that button "Freeze" or "Publish".

**You provide** a `.lead` answer sentence ("Edition 2 changes 3 sections. Sales will see one section for the first time."), then one `.grp` per kind of change, in the order New, Changed, Removed, each with an `h3` and a `.n` count and a list of sections. Each item has the `.name`, its audience in words (`.aud` "Everyone" with the eye is correct here, because the audience is the subject) and a `.det` line; use `.det.first` for a group seeing it for the first time. Then `.left` for drafts left out, `.restart` when sign-off starts again, and the optional `.note` field for the change log.

- Do leave out a group with no items rather than showing "None".
- Do name the drafts in one quiet line; they are not changes.
- Do say whose sign-off restarts and for which group.
- Don't repeat the section's text; the name and who sees it are enough to decide.

**States:** first edition (only New), later edition, with restart, with widening.
