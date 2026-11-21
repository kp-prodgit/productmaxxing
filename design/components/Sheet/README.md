A panel on the right with one thing's detail, while the list it came from stays in view.

**Use** `.sheet` when the person opens a row to read or change it and will go back to the list: a section, a proposal, an edition. Use Dialog for a question that must be answered, and a full page for work that takes over the screen.

**You provide** a `header` with the thing's name as `h2` and a close button `.btn.ghost.x` with `aria-label="Close"`, a scrolling body `.sb` of short labelled blocks (each an `h3` in sentence case and its content), and a `footer` that stays at the bottom with at most one `.btn.pri`. Add `.open` to slide it in, mark the source row `.sel`, and return focus to that row on close.

- Do use the row's own title as the sheet's title, word for word.
- Do keep body labels as plain questions or nouns: "Who sees it", "Owner".
- Don't stack a sheet on a sheet. Replace the content instead.
- Don't hide the primary act in the body; it lives in the footer.

States: closed, open, scrolling body with a fixed footer. It is 420px wide and full width on a phone; the close button is 44px under 768px.
