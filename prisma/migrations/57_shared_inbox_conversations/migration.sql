-- Shared inbox — Phase 1: threading backbone.
-- Additive only: a new Conversation table, new nullable columns on Communication,
-- and a one-time backfill grouping existing messages into conversations.
-- No existing data is modified except setting Communication.conversationId.

-- 1. Conversation table -------------------------------------------------------
CREATE TABLE "Conversation" (
  "id"              TEXT NOT NULL,
  "channel"         TEXT NOT NULL,
  "subject"         TEXT,
  "status"          TEXT NOT NULL DEFAULT 'open',
  "unread"          BOOLEAN NOT NULL DEFAULT false,
  "lastMessageAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt"   TIMESTAMP(3),
  "firstResponseAt" TIMESTAMP(3),
  "messageCount"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "contactId"       TEXT,
  "leadId"          TEXT,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Conversation_status_lastMessageAt_idx" ON "Conversation" ("status", "lastMessageAt");
CREATE INDEX "Conversation_unread_lastMessageAt_idx" ON "Conversation" ("unread", "lastMessageAt");
CREATE INDEX "Conversation_contactId_idx" ON "Conversation" ("contactId");
CREATE INDEX "Conversation_leadId_idx" ON "Conversation" ("leadId");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Conversation_leadId_fkey"    FOREIGN KEY ("leadId")    REFERENCES "Lead"("id")    ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. New Communication columns ------------------------------------------------
ALTER TABLE "Communication"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "messageId"      TEXT,
  ADD COLUMN "inReplyTo"      TEXT,
  ADD COLUMN "references"     TEXT,
  ADD COLUMN "readAt"         TIMESTAMP(3);

CREATE INDEX "Communication_conversationId_idx" ON "Communication" ("conversationId");
CREATE INDEX "Communication_messageId_idx" ON "Communication" ("messageId");

ALTER TABLE "Communication"
  ADD CONSTRAINT "Communication_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Backfill: group existing messages into conversations ---------------------
-- Channel is derived from the message type (unknown/meeting/note -> 'note').
-- One conversation per (contact, channel); lead-only messages grouped per (lead, channel).

-- 3a. Contact-linked messages
INSERT INTO "Conversation" ("id", "channel", "status", "unread", "lastMessageAt", "lastInboundAt", "messageCount", "createdAt", "updatedAt", "contactId", "leadId")
SELECT
  gen_random_uuid()::text,
  CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END,
  'open',
  false,
  MAX(c."occurredAt"),
  MAX(c."occurredAt") FILTER (WHERE c."direction" = 'inbound'),
  COUNT(*)::int,
  MIN(c."occurredAt"),
  MAX(c."occurredAt"),
  c."contactId",
  (ARRAY_AGG(c."leadId") FILTER (WHERE c."leadId" IS NOT NULL))[1]
FROM "Communication" c
WHERE c."contactId" IS NOT NULL
GROUP BY c."contactId", CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END;

UPDATE "Communication" c
SET "conversationId" = conv."id"
FROM "Conversation" conv
WHERE conv."contactId" = c."contactId"
  AND conv."channel" = (CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END)
  AND c."conversationId" IS NULL;

-- 3b. Lead-only messages (no contact)
INSERT INTO "Conversation" ("id", "channel", "status", "unread", "lastMessageAt", "lastInboundAt", "messageCount", "createdAt", "updatedAt", "contactId", "leadId")
SELECT
  gen_random_uuid()::text,
  CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END,
  'open',
  false,
  MAX(c."occurredAt"),
  MAX(c."occurredAt") FILTER (WHERE c."direction" = 'inbound'),
  COUNT(*)::int,
  MIN(c."occurredAt"),
  MAX(c."occurredAt"),
  NULL,
  c."leadId"
FROM "Communication" c
WHERE c."contactId" IS NULL AND c."leadId" IS NOT NULL
GROUP BY c."leadId", CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END;

UPDATE "Communication" c
SET "conversationId" = conv."id"
FROM "Conversation" conv
WHERE c."contactId" IS NULL
  AND conv."contactId" IS NULL
  AND conv."leadId" = c."leadId"
  AND conv."channel" = (CASE WHEN c."type" IN ('email','whatsapp','messenger','instagram','call') THEN c."type" ELSE 'note' END)
  AND c."conversationId" IS NULL;
