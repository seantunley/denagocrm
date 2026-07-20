-- Path A, Phase 2 — custom fields (EAV) on core objects.
-- Additive only: two new tables, no changes to existing data.

CREATE TABLE IF NOT EXISTS "CustomFieldDef" (
  "id" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'text',
  "options" JSONB,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldDef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_entity_key_key" ON "CustomFieldDef"("entity", "key");
CREATE INDEX IF NOT EXISTS "CustomFieldDef_entity_active_order_idx" ON "CustomFieldDef"("entity", "active", "order");

CREATE TABLE IF NOT EXISTS "CustomFieldValue" (
  "id" TEXT NOT NULL,
  "defId" TEXT NOT NULL,
  "recordId" TEXT NOT NULL,
  "value" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldValue_defId_recordId_key" ON "CustomFieldValue"("defId", "recordId");
CREATE INDEX IF NOT EXISTS "CustomFieldValue_recordId_idx" ON "CustomFieldValue"("recordId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CustomFieldValue_defId_fkey'
  ) THEN
    ALTER TABLE "CustomFieldValue"
      ADD CONSTRAINT "CustomFieldValue_defId_fkey"
      FOREIGN KEY ("defId") REFERENCES "CustomFieldDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
