# Brief the manual user-sync problem for multi-workspace admins

## Problem

Admins of customers with several workspaces keep user lists in sync by hand, and people who leave keep access.

## Who has it

The user is the workspace admin or IT lead [T1] [T2]. The buyer is security, which owns the budget for fixing offboarding [T3]. Seen in 4 sources.

## Evidence

- A weekly CSV export and re-upload to each workspace [T1]
- Half a day a month of IT time, and missed offboarding [T2]
- Recurring requests [S1]

## How much it matters

Missed offboarding became an audit finding at one customer [T2], so the cost is risk as well as time. The time cost is about half a day a month per customer [T2]. *Assumption:* other multi-workspace customers spend similar time; a count of such accounts would confirm it.

## What they've asked for

- SCIM sync [T1] [S1]. This tells us the pain is keeping identity in step with their directory, offboarding most of all [T2].

## Signals they'd pay

- Budget this quarter if offboarding is fixed, from the security owner [T3]. This is a stated intent, not a commitment.
- No payment or signed pilot yet.

## Open questions

- Pursue this as a security offboarding problem rather than a convenience feature? **PM decides**.
- How many accounts have more than one workspace?
