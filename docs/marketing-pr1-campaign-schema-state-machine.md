# Marketing PR 1 — Campaign schema and state machine

## Scope

This pull request is the first reviewable slice of the governed marketing upgrade. It adds:

- The canonical campaign and recipient status catalogues.
- Server-side transition validation helpers.
- Additive campaign lifecycle, ownership, scheduling, review and attribution columns.
- Additive recipient delivery/suppression/provider columns.
- Immutable `CampaignVersion` snapshots.
- Append-only `CampaignEvent` records.
- Historical status and version backfills.
- Granular campaign permission records, inherited by roles that already hold `campaigns.manage`.
- Compatibility changes so the existing composer still drains explicitly queued recipients after the recipient default changes to `pending`.

It does **not** add the draft editor, review screens, scheduling UI, communication policy service or the new queue claiming implementation. Those remain separate PRs.

## Migration behaviour

The migration is additive and replay-safe.

Historical campaigns are mapped as follows:

- `draft` remains `draft`.
- `queued` remains `queued`.
- `sending` remains `sending`.
- `sent` with no failures becomes `completed`.
- `sent` with failures becomes `completed_with_errors`.

Historical recipient rows retain their IDs and tracking tokens. The old `failed` status is conservatively mapped to `failed_permanent`, preventing an unreviewed automatic retry.

One deterministic version-1 snapshot is created for each campaign that has no version. Existing records are not assigned new recipients and no messages are sent by the migration.

## Deployment order

1. Back up the production database.
2. Run the unified migration runner.
3. Run `npm run prisma:validate` and `npm run prisma:generate`.
4. Run unit tests, typecheck and build.
5. Confirm historical campaign detail and tracking links still open.
6. Confirm a legacy composer send explicitly creates `queued` recipients and completes with the new final status names.

## Rollback guidance

Application rollback is safe because all new columns and tables are additive. Do not drop the new tables or columns during an emergency application rollback.

If status compatibility must be restored for an older application build, temporarily map:

- `completed` to `sent`.
- `completed_with_errors` to `sent`.
- `failed_permanent` to `failed`.

Keep `CampaignVersion` and `CampaignEvent` data intact. A destructive schema rollback should only occur from a verified backup after confirming that no later marketing PR has written new workflow data.

## Follow-up sequence

1. Persisted campaign drafts and editor workflow.
2. Review, approval and scheduling actions.
3. Delivery-time communication policy and safe queue claims.
4. Campaign list/detail UX.
5. Survey lifecycle and versioning.
