# Pipelines, Forecasting, RBAC and Audit

## Scope

This change adds multiple sales pipelines, pipeline-specific stages, lead forecasting, teams, role-based permissions and an append-only audit-event stream.

It does not add invoicing, payments or accounting workflows.

## Deployment

Apply migration:

```text
prisma/migrations/45_pipelines_forecasting_rbac_audit/migration.sql
```

The migration is additive. Existing stages are moved into the seeded `Retail Sales` pipeline and existing leads inherit their stage pipeline and default probability.

## Seeded roles

- CRM administrator
- Sales manager
- Sales representative
- Marketing user
- Workshop manager
- Technician
- Read-only auditor

Owners retain unrestricted access. Existing members are assigned the Sales representative role for continuity, but management permissions require explicit role grants.

## New screens

- `/forecast`
- `/settings/pipelines`
- `/settings/access`
- `/audit`

The lead Kanban at `/leads` is now scoped to one selected pipeline.

## Forecast fields

- Probability
- Forecast category: pipeline, best case, commit, closed or omitted
- Expected close date
- Estimated cost and estimated gross margin
- Team ownership

Forecast snapshots preserve open, weighted, commit and best-case values for later comparison.

## Record visibility

Users may see:

- All leads, when granted `leads.view_all`
- Their own and team leads, when granted `leads.view_owned`

Mutation permissions are separate from visibility permissions.

## Audit controls

Security-sensitive pipeline, team, role and forecast actions use strict audit writes. `AuditEvent` rows include actor, entity, before/after values, changed fields, request context and correlation identifiers.

Database triggers reject updates and deletes against `AuditEvent`.

## Preview verification

1. Apply the migration to a Neon preview branch.
2. Confirm all existing stages appear under Retail Sales.
3. Confirm existing leads remain visible and retain their stage.
4. Create a second pipeline with stages and add a lead to it.
5. Confirm `/leads?pipeline=<id>` isolates the Kanban correctly.
6. Assign users to teams and verify team-scoped visibility.
7. Grant and remove roles and verify permissions immediately.
8. Update forecast probability, category, close date and team.
9. Capture a forecast snapshot.
10. Verify strict audit events exist for all governance changes.
11. Confirm attempts to update or delete `AuditEvent` fail.

## Rollback

Do not drop the new tables while application code references them. Roll back the application first, then remove triggers, foreign keys, added lead/stage columns and new tables in a separately reviewed migration.
