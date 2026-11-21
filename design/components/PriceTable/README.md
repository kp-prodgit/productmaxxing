Plans side by side, each with its price, who it is for and what it includes, so a reader can pick one in a sentence.

**Use** `.b-price` in the pricing chapter, up to `--measure-wide`. Two to four plans; columns wrap to one under about 520px. For a single price, use `.fig`.

**You provide** one `article.plan` per plan, labelled by its `h3`: in `.top` the name and, on one plan only, `.pill.plain` "Recommended" with `.rec` on the plan; `.p` with the price in `b` and the unit in `span`; `.aim` with one sentence on who it is for; a short `ul` of what is included, each with the check icon, "Everything in Crew" first where it applies. When the audience may see it, close each plan with `.floor`: "Floor price · do not quote" and the floor price. Put currency and billing in `.cap`.

- Do mark the recommended plan with the word. The raised edge only repeats it.
- Do keep included lists to five lines and in the same order across plans.
- Don't include `.floor` for an audience that may not see it. Leave it out of the markup; hiding it with CSS still sends it.
- Don't strike through old prices or add "Save 20%" badges.

States: rest, recommended, with floor price, without floor price.
