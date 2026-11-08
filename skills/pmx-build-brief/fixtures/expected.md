# Build brief for automatic offboarding across workspaces

## Problem

People who leave a multi-workspace customer keep access to some workspaces, which shows up in audits [T2].

## Who it's for

Security and IT at customers with several workspaces on Okta. Security holds the budget [T3].

## What we're building

1. An admin connects the customer's Okta directory.
2. When a person is deactivated in Okta, they are removed from every workspace through the admin API [M1].
3. A daily report lists who was removed, from where and when, for the auditor.

## Real vs stubbed

- Real: the Okta connection, removal through the admin API [M1] and the report. Security will vet these [T3].
- Stubbed: provisioning new users and group sync; admins keep adding people by hand.

## Out of scope

- Identity providers other than Okta
- Provisioning and group sync
- A settings UI beyond connect and disconnect

## Validation target

The security owner at the customer who offered budget [T3], asked for a paid 60-day pilot. Price: **PM decides**.

## Build prompt

```text
Build a service that connects to a customer's Okta directory and, when a user is deactivated in Okta, removes that
user from every workspace through our admin API. Produce a daily report of removals (who, which workspace, when) as
CSV. Okta connection and removal must work for real; provisioning and group sync are out of scope. Include a test
that deactivates a user in an Okta sandbox and checks they're removed from two workspaces.
```

## Open questions

- Pilot price and length. **PM decides**.
- Do we need a security questionnaire ready before the pilot?
