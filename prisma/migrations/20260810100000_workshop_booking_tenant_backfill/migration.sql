-- Workshop booking tenant backfill. ADDITIVE + BEHAVIOUR-PRESERVING: no DDL at all,
-- only the standard "an un-owned row belongs to the founding tenant" backfill that
-- 20260722120000_tenant_people_isolation, 20260722130000_tenant_sales_isolation and
-- 20260722140000_tenant_stock_isolation already ran, statement-for-statement, on
-- these same tables. Nothing is dropped, altered or renamed.
--
-- WHY AGAIN.
-- Those migrations backfilled ONCE, in July. Everything written SINCE has landed
-- with "tenantId" = NULL, because the db.ts guard only stamps while
-- `tenantEnforcing()` is true and it is not, in production. Worse, the workshop
-- booking path (src/lib/bookingSlots.ts and src/app/api/bookings/route.ts) writes
-- through `basePrisma`, which bypasses that guard PERMANENTLY — so those rows are
-- not "unstamped for now", they are unstamped for ever, even after enforcement is
-- switched on. src/lib/statistics.ts (see `tenantSql`) deliberately attributes
-- `tenantId IS NULL` rows to the FOUNDING tenant, which is the right answer while
-- one workshop exists and the wrong answer the moment a second one does: a second
-- workshop's bookings would be filed under the first workshop's calendar, capacity
-- and reports.
--
-- ORDER MATTERS — THIS IS NOT A COSMETIC LIST.
-- 20260727140000_composite_tenant_fks and 20260727150000_composite_tenant_fks_supplement
-- added composite tenant foreign keys:
--     Activity("tenantId","contactId") -> Contact("tenantId","id")
--     Activity("tenantId","leadId")    -> Lead("tenantId","id")
--     Lead("tenantId","contactId")     -> Contact("tenantId","id")
--     Lead("tenantId","productId")     -> Product("tenantId","id")
--     Lead("tenantId","stageId")       -> PipelineStage("tenantId","id")
-- They were added NOT VALID, which skips rows that already existed but STILL
-- enforces every later INSERT and UPDATE — and these statements update an FK
-- column. They are MATCH SIMPLE, so a NULL in any FK column satisfies them
-- trivially: that, and only that, is why the tenantless rows are legal today.
-- The instant a child row is given a tenant the check becomes real, so the child
-- can only be updated once its parents already carry that tenant. Hence
-- Contact / Product / PipelineStage first, then Lead, then Activity.
-- `UPDATE "Activity"` on its own would abort the deploy on a foreign key violation.
--
-- (The reverse direction is safe: updating a parent's key fires its ON UPDATE
-- NO ACTION check against children matching the OLD key, and the old key is
-- (NULL, id), which no child row can equal.)
--
-- ACTIVITY RLS: "Activity" already has ENABLE + FORCE ROW LEVEL SECURITY and the
-- standard "Activity_tenant_isolation" policy from 20260727130000_rls_enforce, so
-- none is added here. Recorded for the reader: the application connects as a
-- BYPASSRLS role, so that policy does not currently evaluate — the application-level
-- scoping this backfill unblocks is what actually separates these rows today.
--
-- REPLAY-SAFE: every statement is scoped to rows that are still NULL, so re-running
-- is a no-op (same guarantee as the tenant_foundation / people_isolation pattern).

-- Parents first — see ORDER MATTERS above.
UPDATE "Contact"       SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "Product"       SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "PipelineStage" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- Lead depends on Contact / Product / PipelineStage above.
UPDATE "Lead"          SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

-- The point of the migration: every workshop booking (and every other activity)
-- taken during the dormant window now names its owner.
UPDATE "Activity"      SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
