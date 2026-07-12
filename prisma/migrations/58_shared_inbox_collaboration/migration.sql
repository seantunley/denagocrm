-- Shared inbox — Phase 2: team collaboration.
-- Additive only: assignment + lastDirection on Conversation, plus staff notes
-- (with @mentions) and per-conversation reply drafts (collision detection).

-- 1. Conversation: assignment + lastDirection ---------------------------------
ALTER TABLE "Conversation"
  ADD COLUMN "lastDirection" TEXT,
  ADD COLUMN "assignedToId"  TEXT,
  ADD COLUMN "assignedAt"    TIMESTAMP(3);

CREATE INDEX "Conversation_lastDirection_lastMessageAt_idx" ON "Conversation" ("lastDirection", "lastMessageAt");
CREATE INDEX "Conversation_assignedToId_status_idx" ON "Conversation" ("assignedToId", "status");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill lastDirection from each conversation's most recent message.
UPDATE "Conversation" conv
SET "lastDirection" = latest."direction"
FROM (
  SELECT DISTINCT ON (c."conversationId") c."conversationId", c."direction"
  FROM "Communication" c
  WHERE c."conversationId" IS NOT NULL
  ORDER BY c."conversationId", c."occurredAt" DESC, c."createdAt" DESC
) latest
WHERE latest."conversationId" = conv."id";

-- 2. Staff notes with @mentions ----------------------------------------------
CREATE TABLE "ConversationNote" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "authorId"       TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "mentions"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationNote_conversationId_createdAt_idx" ON "ConversationNote" ("conversationId", "createdAt");

ALTER TABLE "ConversationNote"
  ADD CONSTRAINT "ConversationNote_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ConversationNote_authorId_fkey"       FOREIGN KEY ("authorId")       REFERENCES "User"("id")         ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Per-conversation reply draft (one owner) --------------------------------
CREATE TABLE "ConversationDraft" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "ownerId"        TEXT NOT NULL,
  "body"           TEXT NOT NULL DEFAULT '',
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationDraft_conversationId_key" ON "ConversationDraft" ("conversationId");

ALTER TABLE "ConversationDraft"
  ADD CONSTRAINT "ConversationDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ConversationDraft_ownerId_fkey"        FOREIGN KEY ("ownerId")        REFERENCES "User"("id")         ON DELETE RESTRICT ON UPDATE CASCADE;
