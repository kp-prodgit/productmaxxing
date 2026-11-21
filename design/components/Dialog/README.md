A question asked before a consequential act, with one way forward and one way out.

**Use** `.scrim` around a `.modal` when the person must confirm who an act will affect before it happens: releasing, withdrawing, removing. Do not use a dialog for information; that is a banner or the screen itself.

**You provide** a title `h2` that is the question or names the act ("Release Edition 2 to Engineering?"), a body `.mb` that says who sees what, and a footer `.mf` with Cancel as `.btn.ghost` and the act as `.btn.pri` with the same words as the title. Set `role="dialog"`, `aria-modal="true"` and `aria-labelledby`, move focus into it, and return focus on close.

**Waiting on your Mac.** When the act is confirmed in a system dialog, replace the body with `.mac`: the `i-mac` icon, "Answer the dialog on this Mac" in `b`, a `.spin`, and what the Mac asks in a `p`. Leave only Cancel in the footer; the move is the person's, on the Mac.

- Do name the groups affected in the body.
- Don't use Yes, OK or Confirm on the primary button.
- Don't open a dialog from inside a dialog.

States: asking, waiting on the Mac, busy (primary with `.spin`).
