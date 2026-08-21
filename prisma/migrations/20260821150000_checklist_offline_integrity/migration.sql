-- Guided-checklist integrity follow-up.
--
-- The first migration was already exercised on the shared development database,
-- so this is a separate, re-entrant migration rather than a rewrite of history.

SET app.bypass_rls = 'on';

ALTER TABLE "ChecklistEntry"
  ADD COLUMN IF NOT EXISTS "maxPhotosSnapshot" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ChecklistEntry"
  ADD COLUMN IF NOT EXISTS "itemIdSnapshot" TEXT;
UPDATE "ChecklistEntry"
SET "itemIdSnapshot" = COALESCE("itemId", 'orphan:' || "id")
WHERE "itemIdSnapshot" IS NULL;
UPDATE "ChecklistEntry" entry
SET "maxPhotosSnapshot" = item."maxPhotos"
FROM "ChecklistItem" item
WHERE entry."itemId" = item."id"
  AND entry."tenantId" = item."tenantId"
  AND entry."maxPhotosSnapshot" = 1;
ALTER TABLE "ChecklistEntry" ALTER COLUMN "itemIdSnapshot" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "ChecklistTemplateRevision" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "items" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChecklistTemplateRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistTemplate_tenantId_id_key"
  ON "ChecklistTemplate"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistTemplateRevision_tenantId_templateId_version_key"
  ON "ChecklistTemplateRevision"("tenantId", "templateId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistTemplateRevision_tenantId_id_key"
  ON "ChecklistTemplateRevision"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "ChecklistTemplateRevision_templateId_version_idx"
  ON "ChecklistTemplateRevision"("templateId", "version");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistItem_tenantId_id_key"
  ON "ChecklistItem"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistRun_tenantId_id_key"
  ON "ChecklistRun"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistEntry_tenantId_id_key"
  ON "ChecklistEntry"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistEntry_tenantId_runId_itemIdSnapshot_key"
  ON "ChecklistEntry"("tenantId", "runId", "itemIdSnapshot");
CREATE UNIQUE INDEX IF NOT EXISTS "ChecklistPhoto_tenantId_id_key"
  ON "ChecklistPhoto"("tenantId", "id");

-- Preserve every current revision before the new write path starts requiring
-- an authoritative snapshot. This also makes the migration safe for the dev
-- database where PR #546's first migration has already been applied.
INSERT INTO "ChecklistTemplateRevision" ("tenantId", "templateId", "version", "items")
SELECT
  template."tenantId",
  template."id",
  template."version",
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', item."id",
        'label', item."label",
        'description', item."description",
        'capture', item."capture",
        'required', item."required",
        'minPhotos', item."minPhotos",
        'maxPhotos', item."maxPhotos",
        'visibility', item."visibility",
        'sortOrder', item."sortOrder"
      ) ORDER BY item."sortOrder", item."createdAt"
    ) FILTER (WHERE item."id" IS NOT NULL),
    '[]'::jsonb
  )
FROM "ChecklistTemplate" template
LEFT JOIN "ChecklistItem" item
  ON item."tenantId" = template."tenantId"
 AND item."templateId" = template."id"
GROUP BY template."tenantId", template."id", template."version"
ON CONFLICT ("tenantId", "templateId", "version") DO NOTHING;

-- A development database may already contain runs stamped with an older
-- template version. Preserve a server-authored snapshot for every referenced
-- version before the composite run→revision foreign key is added. The first PR
-- was never deployed, so these rows are compatibility data rather than a claim
-- that the current item text reconstructs a historic production revision.
INSERT INTO "ChecklistTemplateRevision" ("tenantId", "templateId", "version", "items")
SELECT
  run."tenantId",
  run."templateId",
  run."templateVersion",
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', item."id",
        'label', item."label",
        'description', item."description",
        'capture', item."capture",
        'required', item."required",
        'minPhotos', item."minPhotos",
        'maxPhotos', item."maxPhotos",
        'visibility', item."visibility",
        'sortOrder', item."sortOrder"
      ) ORDER BY item."sortOrder", item."createdAt"
    ) FILTER (WHERE item."id" IS NOT NULL),
    '[]'::jsonb
  )
FROM "ChecklistRun" run
LEFT JOIN "ChecklistItem" item
  ON item."tenantId" = run."tenantId"
 AND item."templateId" = run."templateId"
GROUP BY run."tenantId", run."templateId", run."templateVersion"
ON CONFLICT ("tenantId", "templateId", "version") DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistTemplateRevision_tenantId_fkey') THEN
    ALTER TABLE "ChecklistTemplateRevision"
      ADD CONSTRAINT "ChecklistTemplateRevision_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistTemplateRevision_tenant_template_fkey') THEN
    ALTER TABLE "ChecklistTemplateRevision"
      ADD CONSTRAINT "ChecklistTemplateRevision_tenant_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "ChecklistTemplate"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistItem_tenant_template_fkey') THEN
    ALTER TABLE "ChecklistItem"
      ADD CONSTRAINT "ChecklistItem_tenant_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "ChecklistTemplate"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistRun_tenant_template_fkey') THEN
    ALTER TABLE "ChecklistRun"
      ADD CONSTRAINT "ChecklistRun_tenant_template_fkey"
      FOREIGN KEY ("tenantId", "templateId")
      REFERENCES "ChecklistTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistRun_tenant_revision_fkey') THEN
    ALTER TABLE "ChecklistRun"
      ADD CONSTRAINT "ChecklistRun_tenant_revision_fkey"
      FOREIGN KEY ("tenantId", "templateId", "templateVersion")
      REFERENCES "ChecklistTemplateRevision"("tenantId", "templateId", "version")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistEntry_tenant_run_fkey') THEN
    ALTER TABLE "ChecklistEntry"
      ADD CONSTRAINT "ChecklistEntry_tenant_run_fkey"
      FOREIGN KEY ("tenantId", "runId")
      REFERENCES "ChecklistRun"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistEntry_tenant_item_fkey') THEN
    ALTER TABLE "ChecklistEntry"
      ADD CONSTRAINT "ChecklistEntry_tenant_item_fkey"
      FOREIGN KEY ("tenantId", "itemId")
      REFERENCES "ChecklistItem"("tenantId", "id") ON DELETE SET NULL ("itemId") ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ChecklistPhoto_tenant_entry_fkey') THEN
    ALTER TABLE "ChecklistPhoto"
      ADD CONSTRAINT "ChecklistPhoto_tenant_entry_fkey"
      FOREIGN KEY ("tenantId", "entryId")
      REFERENCES "ChecklistEntry"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "ChecklistTemplateRevision" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChecklistTemplateRevision_tenant_isolation" ON "ChecklistTemplateRevision";
CREATE POLICY "ChecklistTemplateRevision_tenant_isolation" ON "ChecklistTemplateRevision"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChecklistTemplateRevision" FORCE ROW LEVEL SECURITY;
RESET app.bypass_rls;
