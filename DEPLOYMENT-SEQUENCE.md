# Enforcement rollout — deployment sequence

Turning on `TENANT_ENFORCEMENT=enforce` activates FORCE ROW LEVEL SECURITY as the
authoritative isolation boundary. Getting the ORDER wrong can either lock the
founding owner out or make historical data disappear. This is the canonical
sequence — it supersedes the earlier "deploy → migrate → preflight → validate"
ordering, which was internally inconsistent: constraint validation is migration
`20260727180000`, so it already runs *inside* the migration step, not as a
separate step afterwards, and the preflight must run against the NEW schema.

## Why the old ordering was wrong

- "Validate constraints" was listed as a step AFTER the preflight, but the
  `VALIDATE CONSTRAINT` work is migration `20260727180000_validate_composite_fks`
  — it runs during `prisma migrate deploy`. A NULL/dangling row therefore fails
  the *migration*, before any preflight could have reported it.
- The preflight (`scripts/check-production.ts`) reads the new schema (surrogate
  `AppSetting` PK, `User.tenantId`, the full tenant-scoped table list), so it can
  only run once migrations + schema-compatible code are deployed.

## Canonical sequence

1. **Old-schema diagnostic (enforcement OFF).** Run a read-only diagnostic against
   production on the CURRENT schema to surface data that would fail the upcoming
   migrations/preflight: multi-tenant memberships, NULL `tenantId` on any
   tenant-scoped table, orphaned active users, the founding owner's state.
2. **Repair all findings.** Backfill `tenantId`, resolve multi-tenant memberships
   to one tenant each, re-home orphaned users. Nothing below is safe until this
   is clean — a single NULL `tenantId` fails constraint validation in step 4.
3. **Enter the maintenance window.** Writes paused (or drained) so no new
   non-conforming rows appear between the diagnostic and enforcement.
4. **Apply migrations — INCLUDING constraint validation.** `node scripts/apply-migrations.mjs`
   (the same script CI/preview/production use). This runs the composite-FK
   `VALIDATE CONSTRAINT` (`…180000`), the `AppSetting` PK + `tenantId NOT NULL`
   migrations (`…190000`, `…210000`), and the RLS policies. A failure here means
   step 2 was incomplete — fix the data and re-run; the DDL is reentrant.
5. **Deploy the schema-compatible code.** The application build that matches the
   migrated schema (this branch). Enforcement is still OFF at this point.
6. **Run the full new preflight.** `npx tsx scripts/check-production.ts`. It must
   exit 0 — every hard failure (owner lockout conditions, NULL `tenantId` on any
   tenant-scoped table, active users without `User.tenantId`, missing system
   roles) blocks the rollout.
7. **Smoke-test the founding owner — still with enforcement OFF.** Actually log in
   as the founding owner and open `/platform/tenants`. The preflight checks the DB
   invariants; this proves the live login + platform console path works.
8. **Keep enforcement OFF while testing.** Do NOT flip the flag until steps 6–7
   are green. `bypass_rls='on'` is set on every non-tenant path, so off-mode
   behaves exactly as before under FORCE RLS.
9. **Enable enforcement.** Set `TENANT_ENFORCEMENT=enforce`. The guard now sets
   `app.current_tenant` per request and RLS becomes the authoritative boundary.
10. **Immediately re-verify.** Repeat the owner login + `/platform/tenants` smoke
    test, and run the cross-tenant isolation checks (a second tenant's user must
    see none of the founding tenant's data, and vice-versa). If anything is wrong,
    roll back by setting `TENANT_ENFORCEMENT=off` — the app falls back to
    `bypass_rls='on'` on every path, so no data is hidden while you investigate.

## Rollback

Enforcement is a single env flag. `TENANT_ENFORCEMENT=off` makes every path use
`bypass_rls='on'` again; FORCE RLS stays installed but admits every row via the
bypass GUC. No migration rollback is required to disable enforcement.
