-- Support ticketing (FreeScout-style help desk) built on the existing
-- CustomerCase / CustomerCaseMessage tables from migration 50. Additive and
-- idempotent so it is safe to (re)apply to a Neon test branch.

-- ── Mailboxes (ticket queues / departments) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "SupportMailbox" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#ea580c',
  "email" TEXT,
  "signature" TEXT,
  "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoReplyBody" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportMailbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportMailbox_slug_key" ON "SupportMailbox"("slug");

-- ── Tags / labels ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SupportTag" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#64748b',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTag_slug_key" ON "SupportTag"("slug");

CREATE TABLE IF NOT EXISTS "CustomerCaseTag" (
  "caseId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  CONSTRAINT "CustomerCaseTag_pkey" PRIMARY KEY ("caseId", "tagId")
);
CREATE INDEX IF NOT EXISTS "CustomerCaseTag_tag_idx" ON "CustomerCaseTag"("tagId");

-- ── Canned / saved replies ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CannedReply" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "CannedReply_mailbox_idx" ON "CannedReply"("mailboxId");

-- ── Extend CustomerCase for help-desk routing / SLA-lite ─────────────────────
ALTER TABLE "CustomerCase"
  ADD COLUMN IF NOT EXISTS "mailboxId" TEXT,
  ADD COLUMN IF NOT EXISTS "firstResponseAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReplyAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastReplyBy" TEXT,
  ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "CustomerCase_mailbox_status_idx" ON "CustomerCase"("mailboxId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "CustomerCase_assigned_idx" ON "CustomerCase"("assignedToId", "status");

-- ── Extend CustomerCaseMessage with thread type + structured event meta ──────
-- type: 'customer' | 'staff' (public reply) | 'note' (internal) | 'event' (system line item)
ALTER TABLE "CustomerCaseMessage"
  ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'message',
  ADD COLUMN IF NOT EXISTS "meta" JSONB;
-- Backfill thread type from the legacy direction column for existing rows.
UPDATE "CustomerCaseMessage"
  SET "type" = "direction"
  WHERE "type" = 'message' AND "direction" IN ('customer', 'staff');

-- ── Foreign keys (guarded so re-apply is a no-op) ───────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCase_mailboxId_fkey') THEN
    ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_mailboxId_fkey"
      FOREIGN KEY ("mailboxId") REFERENCES "SupportMailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCaseTag_caseId_fkey') THEN
    ALTER TABLE "CustomerCaseTag" ADD CONSTRAINT "CustomerCaseTag_caseId_fkey"
      FOREIGN KEY ("caseId") REFERENCES "CustomerCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerCaseTag_tagId_fkey') THEN
    ALTER TABLE "CustomerCaseTag" ADD CONSTRAINT "CustomerCaseTag_tagId_fkey"
      FOREIGN KEY ("tagId") REFERENCES "SupportTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CannedReply_mailboxId_fkey') THEN
    ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_mailboxId_fkey"
      FOREIGN KEY ("mailboxId") REFERENCES "SupportMailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CannedReply_createdById_fkey') THEN
    ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Seed a default mailbox and route existing unrouted cases to it ───────────
INSERT INTO "SupportMailbox" ("id", "name", "slug", "color", "sortOrder", "active")
  VALUES ('mbx_support', 'Support', 'support', '#ea580c', 0, true)
  ON CONFLICT ("slug") DO NOTHING;
UPDATE "CustomerCase" SET "mailboxId" = 'mbx_support' WHERE "mailboxId" IS NULL;
