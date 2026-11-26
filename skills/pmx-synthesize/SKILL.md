---
name: pmx-synthesize
description: Turns a batch of redacted customer calls, threads and the team's approved internal meetings into new PMX tasks with kind of work, size, rationale, the companies they concern and cited sources. Used by `pmx synthesize`; runs with no tools, and each task waits for the PM's approval.
pmx: {"kind": "core"}
---

# Synthesize signals into candidate tasks

You read customer calls, team messages and the internal meetings your team approved, and propose work a PM's agent
could draft well.

## Output

A single JSON object and nothing else:

```json
{"tasks": [
  {"title": "…", "category": "…", "size": "S|M|L|XL", "rationale": "…", "sources": ["T1", "C4"],
   "support": {"T1": "The buyer asked for SCIM twice.", "C4": "A support thread reports the same gap."},
   "companies": {"T1": {"name": "Acme", "as": "customer"}},
   "sizing": {"cell": "Themes across 3–8 sources", "why": "Five calls on one theme."}, "sameAs": null}
 ],
 "heldOver": [
  {"title": "…", "category": "…", "sources": ["C7"], "why": "…"}
 ]}
```

- `title`: an imperative task title under 80 characters, e.g. "Draft a one-pager for SCIM sync".
- `category`: one of the categories listed in the prompt. Skip work that fits none of them.
- `size`: apply the size rubric in the prompt.
- `sizing.cell`: the rubric cell you matched for this category and size, quoted word for word.
- `sizing.why`: one sentence on why the task fits that cell.
- `rationale`: two to four sentences, in your own words, on what the task needs and why it matters. It is
  the whole description teammates see in the tracker, so say which customer or partner it serves and what's at stake:
  it may name the company (as the sources name it: the company a participant is from, the account), the deal stage,
  and the dates and deadlines the sources state ("Acme's Dec 8 beta", "renewal due Jan 15"). Never quote a source.
  Never include people's names (attendees, speakers or anyone mentioned), speaker labels, transcript lines, meeting
  titles or anything said about a person, and never anything about fundraising: investors, a round, Series A or B,
  valuation, a term sheet, dilution, the cap table, the option pool or a raise. PMX cuts any sentence that does.
- `companies`: for each cited source that was with an outside company, the company as that source names it (in its
  text, its title or its `orgs` email domain) and `as`: `customer`, `prospect` or `partner`. Never invent or guess a
  company: when you aren't sure, leave the source out, and the rationale keeps the role ("a regulated buyer"). Never
  name an investor or a fund. The tracker turns these into the task's source line: "a customer call with Acme
  (Nov 20)".
- `sources`: the IDs of the sources that directly support the task. One is fine; never add a weak or
  unrelated source to reach two.
- `support`: for each cited source, one sentence on how it supports this task, in your own words.
- `sameAs`: null, or the ID of the open task or waiting proposal this is the same need as.
- `heldOver`: the needs you found beyond the task limit, highest value first, each with a title, a category, its
  sources and one sentence on why it matters. Empty when everything fits.

## Choose the kind of work by where the team is

Read the sources for where the work stands, not only for what customers need. A team two months from a release
needs specs, decisions and release work, not another round of problem briefs.

- **The requirements are already in writing, or the scope is agreed** (a requirements list, acceptance terms, a scope
  the team settled, a customer's written spec): propose a `spec`, not a problem brief. The problem is known; the work
  is to specify the build.
- **A decision has a date, or there's an open choice between options** (which integration ships first, which segment
  to sell to, whether something is in the first release): propose a `decision-brief`, and put the date in the
  rationale. Don't turn a decision into a validation plan or a problem brief.
- **The sources are about getting a release out** (readiness items such as a security questionnaire due, partner
  paperwork, a release freeze, a launch checklist): say so in the task. Start the rationale with "Launch
  readiness:", give the date, and use the listed kind that fits the draft: a `spec` for what must be true at release,
  a `decision-brief` for a go or no-go, a `validation-plan` for a buyer's procurement path.
- **A need that's new to the team**: frame it around the customer's problem, not the solution someone asked for
  (a `problem-brief` or `research-synthesis`).

Use only the categories listed in the prompt: they're the kinds of work your team has turned on. When the kind that
fits isn't listed, use the closest one that is and say in the rationale what the work really is.

## Internal meetings your team approved

Items marked `internal="team meeting series"` are recurring internal meetings your team approved for this, like a
launch weekly, exec staff or a design review. Read them as context, above all for what the team already decided:

- **Never propose a task to decide again what one of them decided.** Build on the decision instead, and note it in
  the rationale without naming the meeting or anyone in it: "An internal meeting settled the beta scope on Nov 25:
  …". A draft that re-argues a settled scope wastes the team's review.
- **A task still needs a customer or partner source, or a clear internal decision to act on.** A task whose only
  sources are these meetings is fine for carrying out a decision (a `spec` for a scope the team settled, a
  `decision-brief` for a choice still open with a date) and for launch readiness ("Launch readiness: …"). A problem
  brief, research, a competitive analysis or a validation needs customers: PMX drops one from internal meetings alone.
- They have no outside company: leave them out of `companies`.

## Rules

- Propose at most as many tasks as the prompt's task limit says (15 unless your team changed it), highest value
  first. List every other distinct need in `heldOver`, so none is lost: PMX keeps them for the next run. One task per
  need: when several sources raise the same need (a call, a channel thread, the same meeting from two recorders), make
  one task and cite every one of them.
- When the prompt lists needs held over from the last run, reconsider them first, alongside the new ones.
- When the prompt lists what's already on the team's list and a need is the same as one of those, return it with
  `"sameAs"` set to that ID. PMX adds your sources to it instead of making a second task.
- Only propose work an agent can finish as a written draft with a repo checkout and the cited sources, in one
  of the categories listed in the prompt. Choose the category by its description, and when a category says
  "Propose it when" or "Don't propose it when", follow that. A draft a person then sends, posts or applies (an
  update for stakeholders, proposed tracker changes) is fine; the agent itself never changes code, sends or posts.
- For a need that's new to the team, frame the task around the customer's problem, not the solution someone asked
  for. When the problem is already understood, follow "Choose the kind of work by where the team is" above.
- Never propose anything about a colleague's performance, pay, health or 1:1s, or about fundraising.
- Redaction placeholders like `[PERSON-2]` stay as they are.
