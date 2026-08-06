-- =============================================================================
-- ONE SENDER PER MESSAGE
-- =============================================================================
--
-- Creating an ApprovalStep transactionally enqueues an approval_notify job, and
-- the workflow runtime also calls notifyApprover inline. Both then ran the same
-- "has this already been sent?" check, both passed it, and both sent — because
-- the check and the send were two operations with a network call in between.
-- The approver received the same request twice, from a system that reports
-- delivery as evidence.
--
-- A uniquely-keyed claim row makes the decision atomic: INSERT ... ON CONFLICT
-- DO NOTHING returns a row to exactly one caller, and only that caller sends.
-- The loser reports "skipped", which is the truth.
--
-- Deliberately its own table rather than a column on ApprovalStep: the same
-- pattern applies to recipient sends, reminders and completion delivery, and a
-- claim keyed by an arbitrary string can serve all of them without another
-- migration each time.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "SigningDeliveryClaim" (
  "key" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SigningDeliveryClaim_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "SigningDeliveryClaim_tenant_idx"
  ON "SigningDeliveryClaim"("tenantId", "createdAt");

-- Tenant-scoped like every other signing table, with the same bypass escape
-- hatch the system paths use.
ALTER TABLE "SigningDeliveryClaim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SigningDeliveryClaim" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SigningDeliveryClaim_tenant_isolation" ON "SigningDeliveryClaim";
CREATE POLICY "SigningDeliveryClaim_tenant_isolation" ON "SigningDeliveryClaim"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), ''))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), ''));
