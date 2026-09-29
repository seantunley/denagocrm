-- Replace the capped AppSetting JSON blob with tenant-owned, independently
-- queryable knowledge rows. The old setting is deliberately left in place as a
-- rollback artefact; application reads switch exclusively to this table.
CREATE TABLE IF NOT EXISTS "BotKnowledgeEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "sourceDocumentId" TEXT,
    "sourceLabel" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotKnowledgeEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotKnowledgeEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotKnowledgeEntry_status_check" CHECK ("status" IN ('draft', 'approved', 'expired')),
    CONSTRAINT "BotKnowledgeEntry_source_type_check" CHECK ("sourceType" IN ('manual', 'library')),
    CONSTRAINT "BotKnowledgeEntry_valid_window_check" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" >= "validFrom")
);

CREATE INDEX IF NOT EXISTS "BotKnowledgeEntry_tenant_status_valid_idx"
    ON "BotKnowledgeEntry"("tenantId", "status", "validFrom", "validUntil");
CREATE INDEX IF NOT EXISTS "BotKnowledgeEntry_tenant_updated_idx"
    ON "BotKnowledgeEntry"("tenantId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "BotKnowledgeEntry_search_idx"
    ON "BotKnowledgeEntry" USING GIN (to_tsvector('simple', "title" || ' ' || "content"));

-- Existing values were written by parseBotKnowledge(), but the migration still
-- isolates every date conversion so one hand-edited bad date cannot abort the
-- whole rollout. Invalid dates become open validity boundaries, matching the old
-- parser's behaviour.
DO $$
DECLARE
  setting_row RECORD;
  item JSONB;
  parsed JSONB;
  created_at TIMESTAMP;
  updated_at TIMESTAMP;
  valid_from TIMESTAMP;
  valid_until TIMESTAMP;
  approved_at TIMESTAMP;
BEGIN
  FOR setting_row IN
    SELECT "tenantId", "value" FROM "AppSetting" WHERE "key" = 'BOT_KNOWLEDGE_ENTRIES'
  LOOP
    BEGIN
      parsed := setting_row."value"::jsonb;
      IF jsonb_typeof(parsed) <> 'array' THEN CONTINUE; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(parsed)
      LOOP
        IF COALESCE(btrim(item->>'id'), '') = '' OR COALESCE(btrim(item->>'title'), '') = '' OR COALESCE(btrim(item->>'content'), '') = '' THEN
          CONTINUE;
        END IF;
        BEGIN created_at := NULLIF(item->>'createdAt', '')::timestamptz AT TIME ZONE 'UTC'; EXCEPTION WHEN OTHERS THEN created_at := CURRENT_TIMESTAMP AT TIME ZONE 'UTC'; END;
        BEGIN updated_at := NULLIF(item->>'updatedAt', '')::timestamptz AT TIME ZONE 'UTC'; EXCEPTION WHEN OTHERS THEN updated_at := created_at; END;
        BEGIN valid_from := NULLIF(item->>'validFrom', '')::timestamptz AT TIME ZONE 'UTC'; EXCEPTION WHEN OTHERS THEN valid_from := NULL; END;
        BEGIN valid_until := NULLIF(item->>'validUntil', '')::timestamptz AT TIME ZONE 'UTC'; EXCEPTION WHEN OTHERS THEN valid_until := NULL; END;
        BEGIN approved_at := NULLIF(item->>'approvedAt', '')::timestamptz AT TIME ZONE 'UTC'; EXCEPTION WHEN OTHERS THEN approved_at := NULL; END;
        IF valid_from IS NOT NULL AND valid_until IS NOT NULL AND valid_until < valid_from THEN valid_until := NULL; END IF;

        INSERT INTO "BotKnowledgeEntry" (
          "id", "tenantId", "title", "content", "status", "sourceType",
          "sourceDocumentId", "sourceLabel", "validFrom", "validUntil",
          "approvedAt", "approvedBy", "createdAt", "updatedAt"
        ) VALUES (
          left(item->>'id', 120), setting_row."tenantId", left(item->>'title', 180), left(item->>'content', 5000),
          CASE WHEN item->>'status' IN ('draft','approved','expired') THEN item->>'status' ELSE 'draft' END,
          CASE WHEN item->>'sourceType' IN ('manual','library') THEN item->>'sourceType' ELSE 'manual' END,
          NULLIF(left(item->>'sourceDocumentId', 120), ''), NULLIF(left(item->>'sourceLabel', 220), ''),
          valid_from, valid_until, approved_at, NULLIF(left(item->>'approvedBy', 180), ''),
          COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        ) ON CONFLICT ("id") DO NOTHING;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Bot knowledge migration skipped malformed setting for tenant %: %', setting_row."tenantId", SQLERRM;
    END;
  END LOOP;
END $$;

ALTER TABLE "BotKnowledgeEntry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotKnowledgeEntry_tenant_isolation" ON "BotKnowledgeEntry";
CREATE POLICY "BotKnowledgeEntry_tenant_isolation" ON "BotKnowledgeEntry"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "BotKnowledgeEntry" FORCE ROW LEVEL SECURITY;
