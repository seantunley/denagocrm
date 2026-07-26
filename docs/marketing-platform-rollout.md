# Governed marketing platform rollout

This document covers the complete stacked implementation that replaces direct campaign and survey delivery with persistent drafts, review, immutable versions, durable queues, delivery-time consent, analytics and closed-loop feedback.

## Pull-request order

Merge and deploy in this order:

1. PR #202 — campaign schema and state machine
2. PR #207 — persisted campaign drafts and editor
3. PR #208 — campaign review, approval and scheduling
4. PR #209 — campaign queue safety, consent and retries
5. PR #210 — campaign UX, audiences and templates
6. PR #211 — survey lifecycle and immutable versions
7. PR #212 — survey distributions, queue, reminders and retries
8. PR #213 — survey analytics and closed-loop feedback
9. PR #215 — attribution, overview and calendar
10. Final hardening PR — integration, bypass retirement, module/navigation/help and rollout controls

Each PR is stacked on the previous branch. After its dependency merges, retarget the next PR to `main` before merging it.

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
