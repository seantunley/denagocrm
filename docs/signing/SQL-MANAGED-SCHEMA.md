# SQL-managed signing trust schema

The signing trust layer deliberately uses migration-managed PostgreSQL tables and raw SQL rather than Prisma Client models for its custody, outbox, evidence and recovery hot paths.

The protected tables are:

- `SigningUploadIntent`
- `SigningArtifact`
- `LegalArtifact`
- `SigningOutboxJob`
- `SigningDelivery`
- `SigningIdentityChallenge`
- `SigningEvidenceAnchor`
- `LegalArtifactDestructionRequest`
- `SigningRecoveryAction`

This is an explicit boundary, not an accidental schema omission. These tables use database features that remain authoritative even when application code changes: composite tenant foreign keys, FORCE RLS, append-only/immutability triggers, lease-fenced updates, legal-retention constraints and migration-defined indexes.

## Change rule

A future Prisma migration must not drop or recreate any protected table. `tests/signingSqlSchemaGuard.test.ts` scans every committed migration and fails CI when one contains a `DROP TABLE` for a protected table. Schema changes to these tables must be made through a reviewed SQL migration and accompanied by updates to:

1. the portable backup/restore manifest;
2. the RLS policy migration or RLS drift checks;
3. the raw-query types at the application boundary;
4. the signing acceptance tests and recovery runbook.

Before merging any generated Prisma migration, reviewers must inspect the SQL. Running `prisma migrate dev` is not approval to remove migration-managed objects.
