-- Publishing a dashboard to the rest of the tenant.
--
-- NULL means private, which is every row that exists today, so this is inert on
-- application: nothing becomes visible to anyone until an owner publishes it.
--
-- A TIMESTAMP rather than a boolean. "Shared since when" is the question asked
-- during an access review, and it costs nothing to answer now versus a second
-- migration later. It also makes the audit trail read properly: a boolean tells
-- you a dashboard is shared, not that somebody chose to share it on a Tuesday.
ALTER TABLE "Dashboard" ADD COLUMN IF NOT EXISTS "sharedAt" TIMESTAMP(3);

-- Who published it. Kept even after unpublishing, so the record of who exposed
-- something to the whole workspace does not disappear with the flag.
ALTER TABLE "Dashboard" ADD COLUMN IF NOT EXISTS "sharedById" TEXT;

-- The switcher asks "every dashboard published in this tenant" on every page
-- load, and without an index that is a sequential scan of a table whose rows are
-- otherwise only ever read by (tenantId, userId).
--
-- PARTIAL, on sharedAt IS NOT NULL: published dashboards are the rare case, so
-- indexing only those keeps it small and keeps writes to private dashboards off
-- it entirely.
--
-- tenantId LEADS, matching the existing indexes on this table: the tenant
-- extension puts tenantId in the where of every query, so an index starting
-- anywhere else could not be used as a prefix once enforcement is on.
CREATE INDEX IF NOT EXISTS "Dashboard_tenantId_sharedAt_idx"
  ON "Dashboard" ("tenantId", "sharedAt")
  WHERE "sharedAt" IS NOT NULL;
