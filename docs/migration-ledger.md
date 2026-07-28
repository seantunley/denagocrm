# Migration ledger: what "drift" is real and what is structural noise

Production's `_prisma_migrations` records more migrations than the repository
contains, and `prisma migrate diff` reports differences that are not differences.
Both are expected. This note says which is which, so the next person to run the
integrity check does not chase — or "fix" — something deliberate.

## Ledger rows without a file in the repo

14 migrations are recorded as applied on production but no longer exist on disk.
They are **accurate history**: that SQL really did run. Migrations were renamed and
consolidated over time (`44_marketing_journeys_v3`, `55_pdfme_templates`,
`77_telegram_mini_app`, and so on), and one — `20260728140000_tenant_member_single_tenant` —
was withdrawn from a branch after it had already been applied by a preview
deployment (see [preview-databases.md](preview-databases.md)).

**Leave them.** `scripts/apply-migrations.mjs` iterates the migration folders on
DISK and skips anything already recorded, so an extra ledger row is inert. Deleting
these rows would falsify the record of what ran against the database.

### The one row with `finished_at IS NULL`

`20260712170000_add_pipelines_forecasting_rbac_audit` has no `finished_at` and
looks like a failed migration blocking the ledger. It is **already resolved**:

```
applied_steps_count : 0
rolled_back_at      : 2026-07-12T17:29:38Z
```

It failed, applied zero steps, and was marked rolled back the same day. Prisma does
not treat a rolled-back row as blocking. The work landed under
`45_pipelines_forecasting_rbac_audit` and `52_pipelines_forecasting_rbac_audit`,
both applied, and its objects (`AuditEvent`, `ForecastSnapshot`, `Permission`,
`PipelineStage`, `Role`) all exist. Nothing to do.

Note the trap: querying `finished_at IS NULL` alone makes this look unresolved.
Always check `rolled_back_at` with it.

## Diff lines that are NOT drift

`npx prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --script`
is the right probe, but three classes of output are structural and permanent.

**Composite tenant foreign keys (~311 `DROP CONSTRAINT` lines).** The enforcement
migrations create composite `(tenantId, id)` foreign keys. Prisma cannot model
them, so the differ proposes dropping every one. They are load-bearing for tenant
isolation. `classifyDiffScript` in `scripts/apply-migrations.mjs` ignores DROP
statements precisely for this reason.

**Partial and expression unique indexes.** Prisma cannot express `WHERE` clauses on
indexes, so the schema declares a plain `@unique` and the migration creates the
real partial index. The differ then reports the plain index as missing. On
`StockUnit` this affects `stockNumber` and the `UPPER(serial)` active-serial index:

```sql
CREATE UNIQUE INDEX "StockUnit_stockNumber_key"
  ON "StockUnit" ("stockNumber") WHERE ("stockNumber" IS NOT NULL);
```

Creating the plain version would constrain soft-deleted rows too, which the partial
index deliberately avoids.

**Default expressions that differ only in text.** `AppSetting.id` is stored as
`(gen_random_uuid())::text`; the schema renders `gen_random_uuid()::text`. Same
behaviour, different string, so the differ flags it.

## What the check should actually block on

Only missing tables and columns — the class that 500s the deployed code. That is
what `classifyDiffScript` treats as blocking; index and column-attribute
differences are warnings. As of 2026-07-28 production reports **0 blocking
differences**.

Genuine column-attribute drift found in that same pass was corrected in
`20260728180000_schema_drift_alignment` (`StockUnit.salePriceCents` nullability,
two stale `updatedAt` defaults, and `Survey.active`'s default).

## Running the check on Windows

`node scripts/apply-migrations.mjs --check` fails locally on Windows: it shells out
to `npx`, which Node cannot `execFileSync` there (the script documents this). It
fails CLOSED with "COULD NOT VERIFY THE SCHEMA", which is correct behaviour — an
unverifiable schema is not a passing one. Run the `prisma migrate diff` command
above directly instead, or run the check from CI/Linux.
