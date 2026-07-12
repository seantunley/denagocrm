# Pipelines, forecasting, teams, RBAC and audit

## Scope

This upgrade adds professional sales-governance capabilities without introducing accounting, invoices, payments, receipts, statements, debtor management or Sage integration.

It provides:

- Multiple configurable sales pipelines.
- Pipeline-specific stages and default probabilities.
- Stale-stage thresholds and won/lost stage metadata.
- Per-lead expected close dates, probabilities, forecast categories, estimated costs and team ownership.
- Weighted, commit, best-case and pipeline forecasts.
- Forecast snapshots by month, pipeline, team and owner.
- Teams and team managers.
- Additive user roles and granular permissions.
- Owned/team/all lead record visibility.
- Append-only professional audit events.
- Filtered audit CSV export.
- Governance state in the portable backup.

## Architecture

### Existing models retained

The current `Lead` and `PipelineStage` models remain the operational sales records. Additive columns are applied through migration 45 so existing IDs, quotes, activities, communications and automation links remain intact.

A database trigger keeps `Lead.pipelineId` aligned with its selected stage and updates forecast state when a lead is won, lost or reopened.

### New models

The following standalone models are described in `prisma/governance.prisma`:

- `SalesPipeline`
- `Team`
- `TeamMember`
- `Role`
- `Permission`
- `RolePermission`
- `UserRole`
- `ForecastSnapshot`
- `AuditEvent`

Vercel and package scripts use `--schema ./prisma` so all schema files are generated and validated together.

### Why raw SQL remains in some services

The existing `Lead` and `PipelineStage` Prisma models are preserved to avoid a high-risk rewrite of the large legacy schema in the same release. New columns on those two tables are read and written through parameterised Prisma raw SQL. All standalone new tables are represented in the Prisma schema directory.

## Pipeline behaviour

- Exactly one active, non-deleted pipeline must be the default.
- The migration creates `Retail Sales` as the default pipeline and associates all existing stages and leads with it.
- A default pipeline cannot be disabled or archived.
- A default can only be changed by setting another active pipeline as default first.
- A pipeline cannot be archived while any lead, including historical leads, references it.
- Closed stages must specify either `won` or `lost`.
- Leads may not be created or dragged directly into a closed stage; users must use the explicit won/lost actions.
- Cross-pipeline moves require `leads.change_pipeline` in addition to `leads.change_stage`.

## Forecasting

Open leads support:

- `pipeline`
- `best_case`
- `commit`
- `omitted`

The database trigger owns the terminal categories:

- Won leads become `closed` at 100%.
- Lost leads become `omitted` at 0%.
- Reopened leads return to `pipeline` using the stage default probability.

Forecast snapshots use the selected `YYYY-MM` period and include only leads whose expected close date falls within that month.

Estimated cost is optional CRM information. Blank cost remains `null`; it is not treated as zero and does not create an accounting transaction.

## Seeded roles

### CRM administrator

Receives every permission introduced by this migration. Existing legacy owners also retain their hard safety override.

### Sales manager

Can:

- View and configure pipelines.
- View and manage forecasts.
- View all leads.
- Create, edit, assign, move, win, lose, reopen, relink and delete leads.
- Move leads across pipelines.
- View and manage teams.
- View role definitions.
- View reports.

### Sales representative

Can:

- View active pipelines and forecasts.
- View owned and team leads.
- Create and edit accessible leads.
- Move accessible leads within a pipeline.
- Mark accessible leads won or lost.
- Reopen and relink accessible leads.

A sales representative cannot assign leads, change pipelines, delete leads, manage teams or change permissions unless another role grants that permission.

### Marketing user

Can manage campaigns and journeys and view reports.

### Workshop manager / Technician

Preserve workshop operating access. Users who previously had both CRM and Workshop modules receive both the sales and technician role mappings.

### Read-only auditor

Can view all leads, forecasts, reports and audit history, and export the filtered non-payload CSV audit view.

## Migration role mapping

Existing users are mapped as follows:

- Legacy `owner` → CRM administrator.
- Non-owner with the CRM module → Sales representative and Marketing user.
- Non-owner with the Workshop module → Technician.
- Combined CRM + Workshop users receive all applicable roles.

After migration, the new RBAC tables are authoritative for guarded functionality. A user with no assigned role has no new CRM-governance permissions. The old module list still controls legacy route groups that have not yet been migrated to granular permissions.

## Record visibility

`leads.view_all` permits every non-deleted lead.

`leads.view_owned` permits leads where the current user is:

- The assigned owner.
- The record creator.
- A member of the lead's assigned team.
- The manager of the lead's assigned team.

The same scope is enforced on:

- Kanban board.
- Lead list.
- Won/lost list.
- Lead detail route.
- Lead mutations.
- Forecast rows.
- Forecast snapshots.

Server actions always re-check both the action permission and record scope.

## Audit controls

`AuditEvent` records:

- Actor user and actor type.
- Event and entity identifiers.
- Summary.
- Redacted before and after JSON.
- Changed field names.
- Source, IP, user agent and correlation ID.
- Metadata.
- Timestamp.

Database triggers reject all `UPDATE` and `DELETE` operations on `AuditEvent`.

Sensitive keys containing terms such as password, secret, token, authorization, OTP or signature are redacted before storage.

Governance-sensitive actions use `logAuditStrict`, including:

- Pipeline creation, editing and archival.
- Stage changes.
- Forecast edits and snapshots.
- Team and membership changes.
- Role and user-role changes.
- Lead creation, editing, movement, outcome, reopening, relinking and deletion.
- Audit exports.

CSV export excludes full before/after payloads. It contains event metadata, summary, changed fields and request identifiers only.

## Portable backup compatibility

`src/lib/backup.ts` includes:

- Sales pipelines.
- Pipeline-stage governance columns.
- Per-lead forecast columns.
- Teams and memberships.
- Roles and permissions.
- Forecast snapshots.
- Audit events.

BigInt snapshot values are exported as decimal strings so the JSON backup remains serialisable.

When the dedicated backup PR is merged, rebase this PR and preserve either this compatibility section or equivalent schema-driven coverage for the added Lead and PipelineStage columns.

## Deployment

Vercel runs:

```bash
prisma generate --schema ./prisma
prisma migrate deploy --schema ./prisma
next build
```

Before merge, the preview deployment should run:

```bash
npm run prisma:validate
npm run typecheck
npm run lint
npm run build
```

After migration, run against a recovery or staging Neon branch:

```bash
npm run verify:governance
```

Expected result:

- Exactly one active default pipeline.
- No lead/stage pipeline mismatches.
- No invalid probabilities.
- No orphaned stages.
- No CRM/workshop module users without an RBAC role.
- Both append-only audit triggers present.
- Lead synchronisation trigger present.

Warnings identify active pipelines with no open stage.

## Manual verification

1. Sign in as the owner and open **Sales pipelines**.
2. Confirm existing stages appear under **Retail Sales**.
3. Create a second pipeline with at least one open stage.
4. Open the lead board and switch pipelines.
5. Assign test users to a team and assign Sales manager / Sales representative roles.
6. Verify the representative sees only owned and team leads.
7. Verify the representative cannot move a lead to another pipeline or delete it.
8. Verify the manager can update forecast probability, category, expected close date, cost and team.
9. Capture a monthly snapshot and confirm only that month's expected-close leads are included.
10. Change a lead stage, mark it won/lost, and confirm Audit events contain redacted before/after records.
11. Export a filtered CSV as an auditor or CRM administrator.
12. Attempt direct SQL `UPDATE` or `DELETE` against `AuditEvent`; the database must reject it.
13. Trigger the nightly backup and confirm the `governance` section is present.

## Rollback

Do not attempt to remove this migration from a production database with live governance data.

Preferred rollback:

1. Create or restore a Neon recovery branch from before deployment.
2. Point a staging deployment at that branch and validate the old application.
3. Promote or restore according to the Neon/Vercel recovery runbook.

For an application-only rollback while retaining the migrated database:

- Revert the application commit.
- Leave the additive tables, columns and triggers in place.
- Existing legacy Prisma queries will ignore the extra columns.

Do not drop `AuditEvent` without an approved retention/export decision.

## Cross-PR merge notes

The backup, marketing-journey and governance PRs all touch `package.json`, `vercel.json`, Prisma schema configuration and/or backup behaviour.

Recommended sequence:

1. Merge and validate the backup PR.
2. Rebase the marketing-journey PR and preserve the shared `./prisma` schema-directory configuration.
3. Rebase this governance PR onto the resulting main branch.
4. Resolve cron entries additively; do not overwrite another PR's cron.
5. Confirm the final backup exporter covers journeys, governance tables and the added lead/stage governance columns.

No accounting, invoicing, payment or Sage functionality is introduced by this upgrade.
