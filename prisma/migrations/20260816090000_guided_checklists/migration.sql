-- Guided capture checklists: a configured template, and a run that records what
-- was actually captured against a record in any module.
--
-- PURELY ADDITIVE. Five new tables and nothing else. `Quote.deliveryChecklist`
-- and `JobCardInspectionItem` are deliberately left exactly as they are: they
-- hold live data, the code that reads them still runs, and folding them into
-- this is a later migration that can only be written safely once this shape has
-- been used in anger. A release that both introduces a mechanism and retires the
-- two it replaces has no way back if the new one is wrong.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode and every statement carries its own guard.
-- CONCURRENTLY is not used — it cannot run inside a transaction block, and a
-- failed concurrent build leaves an INVALID index that a re-run will not repair.
-- These tables are empty on creation, so the lock is nothing.

-- ── The configured list ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ChecklistTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChecklistTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChecklistTemplate_tenant_host_active_idx"
    ON "ChecklistTemplate"("tenantId", "host", "active", "sortOrder");

CREATE TABLE IF NOT EXISTS "ChecklistItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "capture" TEXT NOT NULL DEFAULT 'photo',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "minPhotos" INTEGER NOT NULL DEFAULT 1,
    "maxPhotos" INTEGER NOT NULL DEFAULT 1,
    "visibility" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChecklistItem_template_order_idx"
    ON "ChecklistItem"("templateId", "sortOrder");
CREATE INDEX IF NOT EXISTS "ChecklistItem_tenant_idx"
    ON "ChecklistItem"("tenantId");

-- ── What was actually captured ──────────────────────────────────────────────
--
-- ChecklistRun.id, ChecklistEntry.id and ChecklistPhoto.id have NO database
-- default on purpose: they are minted on the device so a capture can begin with
-- no signal, and the sync upserts by that id so running it twice converges
-- rather than duplicating. See the model docs in prisma/checklists.prisma.

CREATE TABLE IF NOT EXISTS "ChecklistRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "hostType" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    CONSTRAINT "ChecklistRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChecklistRun_tenant_host_idx"
    ON "ChecklistRun"("tenantId", "hostType", "hostId");
CREATE INDEX IF NOT EXISTS "ChecklistRun_tenant_template_completed_idx"
    ON "ChecklistRun"("tenantId", "templateId", "completedAt");

CREATE TABLE IF NOT EXISTS "ChecklistEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT,
    "labelSnapshot" TEXT NOT NULL,
    "descriptionSnapshot" TEXT,
    "captureSnapshot" TEXT NOT NULL,
    "requiredSnapshot" BOOLEAN NOT NULL DEFAULT true,
    "minPhotosSnapshot" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "value" TEXT,
    "skipReason" TEXT,
    "recordedAt" TIMESTAMP(3),
    CONSTRAINT "ChecklistEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChecklistEntry_run_order_idx"
    ON "ChecklistEntry"("runId", "sortOrder");
CREATE INDEX IF NOT EXISTS "ChecklistEntry_tenant_idx"
    ON "ChecklistEntry"("tenantId");

CREATE TABLE IF NOT EXISTS "ChecklistPhoto" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChecklistPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChecklistPhoto_entry_idx"
    ON "ChecklistPhoto"("entryId");
CREATE INDEX IF NOT EXISTS "ChecklistPhoto_tenant_idx"
    ON "ChecklistPhoto"("tenantId");

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and this runner opens no
-- transaction, so a re-run after a partial application must not die on 42710.
--
-- The delete rules are not uniform, and each difference is deliberate:
--
--   Item -> Template          CASCADE.  A deleted list takes its steps with it.
--   Entry -> Run              CASCADE.  A deleted run takes its answers.
--   Photo -> Entry            CASCADE.  An answer's evidence belongs to it.
--   Entry -> Item             SET NULL. Deleting a STEP from a template must
--                             never delete evidence already captured against it;
--                             the entry's own snapshots keep it readable.
--   Run  -> Template          RESTRICT. A template with completed runs against
--                             it cannot be deleted at all — that would destroy
--                             the only record of what was asked. Templates are
--                             deactivated (`active = false`), not removed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistTemplate_tenantId_fkey') THEN
    ALTER TABLE "ChecklistTemplate"
      ADD CONSTRAINT "ChecklistTemplate_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistItem_tenantId_fkey') THEN
    ALTER TABLE "ChecklistItem"
      ADD CONSTRAINT "ChecklistItem_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistItem_templateId_fkey') THEN
    ALTER TABLE "ChecklistItem"
      ADD CONSTRAINT "ChecklistItem_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistRun_tenantId_fkey') THEN
    ALTER TABLE "ChecklistRun"
      ADD CONSTRAINT "ChecklistRun_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistRun_templateId_fkey') THEN
    ALTER TABLE "ChecklistRun"
      ADD CONSTRAINT "ChecklistRun_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistEntry_tenantId_fkey') THEN
    ALTER TABLE "ChecklistEntry"
      ADD CONSTRAINT "ChecklistEntry_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistEntry_runId_fkey') THEN
    ALTER TABLE "ChecklistEntry"
      ADD CONSTRAINT "ChecklistEntry_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "ChecklistRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistEntry_itemId_fkey') THEN
    ALTER TABLE "ChecklistEntry"
      ADD CONSTRAINT "ChecklistEntry_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "ChecklistItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistPhoto_tenantId_fkey') THEN
    ALTER TABLE "ChecklistPhoto"
      ADD CONSTRAINT "ChecklistPhoto_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistPhoto_entryId_fkey') THEN
    ALTER TABLE "ChecklistPhoto"
      ADD CONSTRAINT "ChecklistPhoto_entryId_fkey"
      FOREIGN KEY ("entryId") REFERENCES "ChecklistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── Tenant isolation ────────────────────────────────────────────────────────
--
-- FORCE applies the policy to the table owner too, which is what makes it a
-- boundary rather than a suggestion. The bypass arm is the same escape hatch
-- basePrisma uses; there is deliberately no `tenantId IS NULL` arm, because
-- tenantId is NOT NULL on all five tables.

ALTER TABLE "ChecklistTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistTemplate_tenant_isolation" ON "ChecklistTemplate";
CREATE POLICY "ChecklistTemplate_tenant_isolation" ON "ChecklistTemplate"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistTemplate" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ChecklistItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistItem_tenant_isolation" ON "ChecklistItem";
CREATE POLICY "ChecklistItem_tenant_isolation" ON "ChecklistItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistItem" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ChecklistRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistRun_tenant_isolation" ON "ChecklistRun";
CREATE POLICY "ChecklistRun_tenant_isolation" ON "ChecklistRun"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistRun" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ChecklistEntry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistEntry_tenant_isolation" ON "ChecklistEntry";
CREATE POLICY "ChecklistEntry_tenant_isolation" ON "ChecklistEntry"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistEntry" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ChecklistPhoto" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistPhoto_tenant_isolation" ON "ChecklistPhoto";
CREATE POLICY "ChecklistPhoto_tenant_isolation" ON "ChecklistPhoto"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistPhoto" FORCE ROW LEVEL SECURITY;
