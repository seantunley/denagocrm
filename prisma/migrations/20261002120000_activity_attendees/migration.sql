-- More than one staff member at a meeting. Activity keeps its single assignee
-- (the owner); everyone else attending is a row here. Additive only.

CREATE TABLE IF NOT EXISTS "ActivityAttendee" (
  "activityId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityAttendee_pkey" PRIMARY KEY ("activityId", "userId"),
  CONSTRAINT "ActivityAttendee_activityId_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ActivityAttendee_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ActivityAttendee_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ActivityAttendee_userId_idx" ON "ActivityAttendee"("userId");
CREATE INDEX IF NOT EXISTS "ActivityAttendee_tenantId_idx" ON "ActivityAttendee"("tenantId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe.
ALTER TABLE "ActivityAttendee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ActivityAttendee_tenant_isolation" ON "ActivityAttendee";
CREATE POLICY "ActivityAttendee_tenant_isolation" ON "ActivityAttendee"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ActivityAttendee" FORCE ROW LEVEL SECURITY;
