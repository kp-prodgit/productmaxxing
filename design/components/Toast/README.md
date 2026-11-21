A short line at the bottom of the screen that says an act happened, with a way back.

**Use** `.toast` right after the person acts: released, copied, saved, withdrawn. Use Banner for a condition that lasts, and Dialog for anything that needs an answer.

**You provide** the outcome in `.tt` as a past-tense sentence that matches the button ("Released to ELT" after "Release to ELT"), and an optional Undo `button`. Add `.show` to bring it up from the bottom centre and remove it after about five seconds, longer when it has Undo. Put it in an `aria-live="polite"` region with `role="status"`.

- Do keep it to one line. If the person must read more, it belongs on the screen.
- Do offer Undo for any act that can be reversed quietly.
- Don't show a toast for an act that failed. Say so in a banner where the act was.
- Don't put a second button beside Undo.

States: hidden, shown, Undo hover (`toast-hover`), Undo focus-visible (ring in `bg`). The ground is `fg` and the text `bg`, so it inverts with the theme. Undo is 44px tall under 768px.
