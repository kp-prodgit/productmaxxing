The frame of every work screen: a labelled nav on the left and the work area beside it.

**Use** `.app` once per page, for the Workspace and the studio. Never for a briefing page; readers get no nav. Every item has a word; an icon-only rail is not part of this system.

**You provide** `nav.nav` with an `aria-label`, the workspace header `.ws` (a `.logo` tile with the team's initials, the team name in `b`, where it lives in `small`: "On this Mac"), section labels `.label`, items `.ni` (a real `a` or `button` with an icon and a word, and an optional count in `.badge` with its noun in `.sr-only`), `aria-current="page"` on the current item, and a `.foot` for Settings and Help. Then `main.main` holding a `.topbar` (a `.navbtn` with `aria-expanded` and `aria-controls`, and the current item's word) and a `.page` that opens with `.answer`.

- Do keep at most seven items above the footer.
- Do count only what waits on the person.
- Don't colour nav icons. Place colours belong to flow diagrams.
- Don't repeat the nav item's word as the page title; the answer line says where things stand.

States: rest, hover, current (`select`), focus-visible, disabled. Under 640px the nav becomes a drawer behind the top bar; toggle `.navopen` on `.app` and show `.navscrim`.
