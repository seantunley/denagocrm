# Governed marketing platform rollout

This document covers the complete stacked implementation that replaces direct campaign and survey delivery with persistent drafts, review, immutable versions, durable queues, delivery-time consent, analytics and closed-loop feedback.

## Pull-request order

**The entire stack has been consolidated into a single release PR: #222 (`agent/marketing-consolidated`), based on current `main`. Merge and deploy only #222.**

The originally stacked PRs are **superseded** and must **not** be merged or deployed individually:

- #202, #207, #208, #209, #210, #211, #212, #213, #215 (stacked rungs)
- #216 (final hardening — its content is folded into #222)

Their PR numbers below are retained only as historical attribution for each scope. Close them once #222 is approved.

| Scope | Historical PR |
|---|---:|
| Campaign schema and state machine | #202 |
| Persisted campaign drafts and editor | #207 |
| Campaign review, approval and scheduling | #208 |
| Campaign queue safety, consent and retries | #209 |
| Campaign UX, audiences and templates | #210 |
| Survey lifecycle and immutable versions | #211 |
| Survey distributions, queue, reminders and retries | #212 |
| Survey analytics and closed-loop feedback | #213 |
| Attribution, overview and calendar | #215 |
| Integration, bypass retirement, module/navigation/help, rollout controls | #216 |

Because #222 is a single branch off `main`, there is no per-rung retargeting: validate and merge #222 as one unit.

## Pre-deployment checks

1. Take a verified PostgreSQL backup.
2. Confirm the marketing module is enabled only for intended tenants.
3. Confirm email and SMS providers are configured per tenant.
4. Confirm the tenant cron secret and schedule are healthy.
5. Run Prisma validation and generation against the complete stacked branch.
6. Apply every migration to a production-like copy of the current database.
7. Run typecheck, lint, unit tests, migration-contract tests and the production build.
8. Exercise campaign and survey queues with two concurrent workers.

## Migration order

Migrations are additive and must be applied in repository timestamp order. Important groups are:

- campaign lifecycle, versions, event ledger and permissions
- marketing audiences and template versions
- survey lifecycle and immutable versions
- survey distributions and recipient queue fields
- survey completion and closed-loop follow-up triggers
- campaign UTM, touch and conversion attribution
- final queue leases, review separation, constraints and indexes

Do not deploy application code that references later migration fields before those migrations complete.

## Cutover sequence

1. Apply migrations while the current application remains online.
2. Deploy the full application stack with the marketing module temporarily disabled for non-test tenants.
3. Enable one internal tenant.
4. Create and approve a small campaign, then queue it for two internal recipients.
5. Confirm one provider delivery per recipient, event-ledger entries, suppression reasons and completion status.
6. Publish a test survey version and create a two-recipient distribution.
7. Confirm frozen public rendering, reminder behavior, completion metrics and negative-feedback follow-up creation.
8. Confirm a tracked campaign click attributes a newly created lead inside the configured window.
9. Enable remaining tenants gradually.

## Compatibility behavior

- Existing campaign records and tracking tokens are preserved.
- Existing sent campaigns are mapped to governed completed states.
- Existing surveys receive a historical version snapshot.
- Existing public survey responses without an explicit version use a controlled legacy snapshot fallback.
- Legacy `/campaigns` and `/surveys` routes remain readable, but direct bulk launch actions are retired.
- New operations live under `/marketing/*`.

## Rollback

The database changes are intentionally additive. Prefer an application rollback rather than dropping columns or tables.

1. Disable the marketing module for affected tenants.
2. Pause the tenant cron or disable only marketing queue workers.
3. Roll back the application deployment to the previous release.
4. Keep all added tables, columns and event ledgers intact.
5. Do not delete queued recipient rows, immutable versions, tracking tokens or attribution records.
6. Correct the defect and redeploy forward.

Dropping the new schema is not a safe rollback because it would destroy approval evidence, consent decisions, delivery history, survey versions and attribution data.

## Post-deployment monitoring

Monitor:

- stale `sending` campaign and survey recipients
- temporary failures that exceed retry windows
- campaigns or distributions stuck in queued/sending states
- suppression and complaint rates by tenant and channel
- reminder lease rows left in `reminder_sending`
- campaign counters compared with recipient and conversion ledgers
- survey distribution counters compared with response rows
- unresolved critical survey follow-ups
- attribution conversion volume and revenue anomalies

## Operational ownership

Marketing operators own drafts, audiences, templates and day-to-day execution. Reviewers and approvers own governance decisions. System administrators own provider configuration, cron health and migration deployment. Support managers own escalated survey-recovery cases.
