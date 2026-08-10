ALTER TABLE "BotFlowOutbox"
  ADD COLUMN IF NOT EXISTS "flowVersionId" TEXT;

CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenant_flow_version_status_idx"
  ON "BotFlowOutbox"("tenantId", "flowVersionId", "status");

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and the migration runner opens no
-- transaction, so a re-run after a partial application must not die on 42710.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BotFlowOutbox_flowVersionId_fkey') THEN
    ALTER TABLE "BotFlowOutbox"
      ADD CONSTRAINT "BotFlowOutbox_flowVersionId_fkey"
      FOREIGN KEY ("flowVersionId") REFERENCES "BotFlowVersion"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
