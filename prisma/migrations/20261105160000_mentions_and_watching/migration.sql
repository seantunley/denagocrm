-- @mentions that notify, watching a record, and team notes on job cards (2026-11-05). Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "StaffNotification" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "event" TEXT,
  "actorId" TEXT,
  "recordType" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "snippet" TEXT,
  "href" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "StaffNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "StaffNotification_tenantId_userId_readAt_createdAt_idx"
  ON "StaffNotification"("tenantId", "userId", "readAt", "createdAt");

CREATE TABLE IF NOT EXISTS "RecordWatch" (
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "recordType" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecordWatch_pkey" PRIMARY KEY ("tenantId", "userId", "recordType", "recordId")
);
CREATE INDEX IF NOT EXISTS "RecordWatch_tenantId_recordType_recordId_idx" ON "RecordWatch"("tenantId", "recordType", "recordId");

CREATE TABLE IF NOT EXISTS "JobCardNote" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "jobCardId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "mentions" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobCardNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "JobCardNote_jobCardId_createdAt_idx" ON "JobCardNote"("jobCardId", "createdAt");
CREATE INDEX IF NOT EXISTS "JobCardNote_tenantId_idx" ON "JobCardNote"("tenantId");
DO $$ BEGIN
  ALTER TABLE "JobCardNote" ADD CONSTRAINT "JobCardNote_jobCardId_fkey"
    FOREIGN KEY ("jobCardId") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Same isolation as every table since the RLS cutover; without the policy the tables fail closed in production.
ALTER TABLE "StaffNotification" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StaffNotification_tenant_isolation" ON "StaffNotification";
CREATE POLICY "StaffNotification_tenant_isolation" ON "StaffNotification"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "StaffNotification" FORCE ROW LEVEL SECURITY;

ALTER TABLE "RecordWatch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RecordWatch_tenant_isolation" ON "RecordWatch";
CREATE POLICY "RecordWatch_tenant_isolation" ON "RecordWatch"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "RecordWatch" FORCE ROW LEVEL SECURITY;

ALTER TABLE "JobCardNote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardNote_tenant_isolation" ON "JobCardNote";
CREATE POLICY "JobCardNote_tenant_isolation" ON "JobCardNote"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "JobCardNote" FORCE ROW LEVEL SECURITY;
