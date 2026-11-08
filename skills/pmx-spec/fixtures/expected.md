# Draft a one-pager for SCIM sync

## Problem

Admins at multi-workspace customers keep user lists in sync by hand [T1], and requests are recurring [S1].

## Evidence

- Weekly CSV export as a workaround [T1]
- Third SCIM request this month [S1]

## Validated by

Not validated yet. No customer has committed to pay for SCIM; the evidence is requests [T1] [S1]. A paid pilot with one multi-workspace admin would validate it.

## Proposal

Add SCIM 2.0 user provisioning for SSO-enabled workspaces. Non-goals: group sync, custom attributes.

## Success metrics

- Time to add a workspace's users drops from hours to minutes.

## Open questions

- Which identity providers first? **PM decides**.
