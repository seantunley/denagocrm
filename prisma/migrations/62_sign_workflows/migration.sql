-- Visual signing workflows (node/condition graphs that compile to the hub's recipient chain)
CREATE TABLE IF NOT EXISTS "SignWorkflow" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "graphJson" JSONB NOT NULL,
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "SignWorkflow_pkey" PRIMARY KEY ("id")
);

-- Each document template can name a default signing workflow (overridable at send time).
ALTER TABLE "DocBuilderTemplate" ADD COLUMN IF NOT EXISTS "defaultWorkflowId" TEXT;

DO $$ BEGIN
  ALTER TABLE "DocBuilderTemplate"
    ADD CONSTRAINT "DocBuilderTemplate_defaultWorkflowId_fkey"
    FOREIGN KEY ("defaultWorkflowId") REFERENCES "SignWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
