A link: an action or a destination set as underlined words instead of a button.

**Use** `.link` for quiet acts beside a row or under a field ("Change who sees it", "Show 4 more"), on a `button` when it acts and an `a` when it goes somewhere. Its text is `fg` with a `line-2` underline that turns `fg` on hover. Use `.link.accent` for a link inside running text, where `accent` and a full underline set it apart from the sentence around it.

**You provide** the words, which are the action or the place, and the element: `button type="button"` or `a href`.

- Do write the link as what happens or where it goes. "See what ELT sees", never "Click here" or "More".
- Do keep `.link.accent` for running text only. In a row of controls, `accent` belongs to the one primary button.
- Don't rely on the underline to show it is a link. The `line-2` underline is below 3:1; the words and their place make it read as an action.
- Don't use `.link` for the person's next step. That is `.btn.pri`.

States: rest, hover (underline `fg`, or 2px on `.accent`), focus-visible, disabled (`aria-disabled`, `fg-2`, with the reason beside it). It inherits the surrounding type size.
