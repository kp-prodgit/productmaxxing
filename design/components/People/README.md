A person shown by name, with an initials disc beside it.

**Use** `.who` wherever an owner, an author or someone the person waits on is named: rows, sheets, reason lines. Never show initials alone; a disc without a name is a riddle.

**You provide** the initials in `.av` with `aria-hidden="true"` and the full name as text. Add `.role` for a job title where it helps: "Head of Product". For several people, show the first by name and the rest as a count: "Priya Nair +2". Then make the chip focusable with `tabindex="0"`, put every name in `.all` ("Priya Nair, Omar Haddad and Elena Petrova"), hide the short form from screen readers, and repeat the names in `title`. The full list shows on hover and focus.

- Do use the name the team uses, first and last.
- Do name the person who has the next move in a wait: "Needs sign-off from Priya Nair".
- Don't give people colours. Discs are all one neutral ground.
- Don't use the compact form when there are only two people; name both.

States: single, with role, compact with the full list on focus and hover.
