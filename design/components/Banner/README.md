One sentence about the whole screen, with the way to act on it.

**Use** `.banner` at the top of the work area for a condition that affects everything below: something waiting, something stale, something broken, something held back. Use Toast for the result of an act, and a row's meta line for anything about one row.

**You provide** a tone class, an icon, the sentence in a `p`, and an optional action as a link. Tones: `.info` (`accent-soft`, with `i-info`), `.warn` (`warn-soft`, the default, with `i-alert`), `.bad` (`bad-soft`, with `i-stop`) and `.held` (`held-soft`, with `i-lock`). Give it `role="status"`, or `role="alert"` for `.bad`.

- Do say what happened and what happens next: "Your changes are kept on this Mac and go out when it is back."
- Do name the act on the link: "Send to Sales", "Try again".
- Don't stack more than two banners. If there are three, the screen's answer line is wrong.
- Don't use a banner for good news. Success is a toast, or nothing.

States: info, warn, bad, held; each carries its own icon shape and words, so it reads in greyscale. The link has hover and focus-visible, and a 44px target under 768px.
