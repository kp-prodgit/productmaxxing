A button states what will happen in two or three words.

**Use** `.btn.pri` once per screen, card footer or dialog, for the person's next step; `.btn` for everything else beside it; `.btn.ghost` for Cancel and other ways out; `.btn.danger` for an act that removes or withdraws. `.sm` is for dense rows only.

**You provide** the label (a verb, or verb plus object: "Release to ELT"), and the handler. While the act runs set `aria-busy="true"` and `disabled`, put a `.spin` first and switch the label to the gerund ("Releasing…").

**The Mac mark.** When the act is confirmed in a dialog on the person's Mac, put the `i-mac` icon before the label and give the button a `title` saying so. The mark is a promise: nothing happens from the click alone.

- Do write the outcome on the button. "Approve", "Release to ELT", "Record sign-off".
- Don't use OK, Submit, Yes, Continue.
- Don't place two filled buttons in one region. If two acts compete, one of them is not the next step.
- Don't disable a button without saying why next to it.

States: rest, hover (`hover`), pressed, focus-visible (2px `accent` ring), busy, disabled (45%). Height `control`, 44px under 768px.
