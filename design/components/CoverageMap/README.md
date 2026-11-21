The studio home's overview: every document on one line, saying where it stands the way a person would say it.

**Use** `.cov` once on the studio home, below the answer line. It replaces the matrix of pills and dots. Not for a single release (use ReleaseCard).

**You provide** one `li.doc` per document, in the order the team works on them. Each has `.name`, `.where` (a fragment: "With ELT · Engineering next", "Released to everyone · edition 2", "Draft · 2 sections", "Not started"), `.steps` with five `i` in the track's states (`.is-done`, `.is-now`, `.is-held`, `.is-bad`, none) and an `aria-label` that says the same in words, an optional `.chg`, and one `.btn.ghost.sm` (Open, or Start when `.is-empty`). Add a `details.vert` only where a vertical differs: "Healthcare differs in 2 sections".

- Do write `.where` from state; the bar repeats it and never says more.
- Do leave a vertical out when it matches the company version.
- Don't add column heads; each line reads on its own.
- Don't show more than one action per line.

Under 640px of its own width each line stacks into name, place and bar.

**States:** released, in progress, waiting, failed, draft, not started, changed, with verticals.
