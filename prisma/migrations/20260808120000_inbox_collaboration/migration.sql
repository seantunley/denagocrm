-- =============================================================================
-- SHARED INBOX — PHASE 2: assignment, staff notes, reply drafts
-- =============================================================================
--
-- Rebuilt from PR #17, which was merged on 2026-07-14 into
-- feature/shared-inbox-phase1 rather than main. GitHub reported it MERGED, so
-- Phase 1 shipped and Phase 2 never did: production has had migration 57 and not
-- 58 for three and a half weeks.
--
-- This is NOT that migration replayed. The original predates the whole tenant
-- isolation programme and created both tables with no tenantId at all, which
-- today fails two tests that did not exist then:
--   tests/tenantSchemaContract.test.ts   — every model is global or tenant-scoped
--   tests/rlsPolicyCoverage.test.ts      — every tenant-scoped table has a policy
-- Both new tables therefore carry tenantId, a composite tenant foreign key, and
-- an RLS policy, matching what every table added since 20260727130000 does.
--
-- Additive throughout: three nullable columns, two new tables. Nothing is
-- dropped, nothing is made NOT NULL, and no existing row changes except the
-- lastDirection backfill, which only fills a column created in this migration.

-- ── 1. Conversation: assignment and direction ───────────────────────────────
--
-- `unread` already exists and answers a different question. Unread means nobody
-- has LOOKED; lastDirection = 'inbound' means the customer spoke last and is
-- waiting on an answer. A thread can be read and still unanswered, which is the
-- one an inbox needs to surface.
ALTER TABLE "Conversation"
  ADD COLUMN IF NOT EXISTS "lastDirection" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedToId"  TEXT,
  ADD COLUMN IF NOT EXISTS "assignedAt"    TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Conversation_lastDirection_lastMessageAt_idx"
  ON "Conversation" ("lastDirection", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "Conversation_assignedToId_status_idx"
  ON "Conversation" ("assignedToId", "status");

-- SET NULL, not CASCADE: an assignee leaving must not delete the customer's
-- conversation. It becomes unassigned, which is the correct state.
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill from each conversation's most recent message, so the new column is
-- true of existing threads rather than uniformly NULL until the next message.
UPDATE "Conversation" conv
SET "lastDirection" = latest."direction"
FROM (
  SELECT DISTINCT ON (c."conversationId") c."conversationId", c."direction"
  FROM "Communication" c
  WHERE c."conversationId" IS NOT NULL
  ORDER BY c."conversationId", c."occurredAt" DESC, c."createdAt" DESC
) latest
WHERE latest."conversationId" = conv."id"
  AND conv."lastDirection" IS NULL;

-- ── 2. Staff notes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ConversationNote" (
  "id"             TEXT NOT NULL,
  -- Multi-tenancy (Phase B — additive/inert): owning tenant, NULL until stamping
  -- is enabled. See docs/TENANT-ENFORCEMENT-PREREQUISITES.md for the order.
  "tenantId"       TEXT,
  "conversationId" TEXT NOT NULL,
  "authorId"       TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "mentions"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationNote_pkey" PRIMARY KEY ("id")
);

-- THE TABLES MAY ALREADY EXIST, WITHOUT tenantId.
--
-- Production has ConversationNote and ConversationDraft from the original
-- migration 58, created outside the recorded history — `_prisma_migrations` lists
-- only 57. So CREATE TABLE IF NOT EXISTS above is a no-op there, leaving the July
-- shape, and every statement below that names tenantId would fail: the index
-- first, then the composite FK, then the RLS policy. A failed migration fails the
-- whole Vercel deployment, and CI could not have caught it because CI applies
-- migrations to an EMPTY database where the table does not pre-exist.
--
-- That is the same "green in CI, broken only in production" shape that took
-- deployments down for three hours on 2026-08-07. Adding the column explicitly
-- makes both paths converge on the same schema.
-- Each table's compatibility ALTER sits immediately after its OWN create. Both
-- were placed here in the first attempt, which meant altering ConversationDraft
-- eleven statements before it is created — `relation "ConversationDraft" does not
-- exist`, and the whole migration step died. Fixing one blind spot by introducing
-- an ordering bug is not an improvement; keeping each ALTER next to its CREATE is
-- what makes that hard to do again.
ALTER TABLE "ConversationNote" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
-- Present in this migration's own CREATE TABLE, absent from the 2026-07 one.
ALTER TABLE "ConversationNote" ALTER COLUMN "mentions" SET DEFAULT ARRAY[]::TEXT[];

CREATE INDEX IF NOT EXISTS "ConversationNote_conversationId_createdAt_idx"
  ON "ConversationNote" ("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "ConversationNote_tenantId_idx" ON "ConversationNote" ("tenantId");

DO $$ BEGIN
  ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RESTRICT on the author: a note is a record of who said what, and deleting the
-- person must not silently rewrite the handover history their colleagues rely on.
DO $$ BEGIN
  ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Reply drafts ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ConversationDraft" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT,
  "conversationId" TEXT NOT NULL,
  "ownerId"        TEXT NOT NULL,
  "body"           TEXT NOT NULL DEFAULT '',
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationDraft_pkey" PRIMARY KEY ("id")
);

-- Same reason as ConversationNote above: production has this table from the
-- unrecorded July migration, so the CREATE is a no-op there and the column has to
-- be added explicitly before anything names it.
ALTER TABLE "ConversationDraft" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- One draft per conversation, by design: the collision warning depends on there
-- being a single answer to "who is replying to this right now?".
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationDraft_conversationId_key"
  ON "ConversationDraft" ("conversationId");
CREATE INDEX IF NOT EXISTS "ConversationDraft_tenantId_idx" ON "ConversationDraft" ("tenantId");

DO $$ BEGIN
  ALTER TABLE "ConversationDraft" ADD CONSTRAINT "ConversationDraft_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ConversationDraft" ADD CONSTRAINT "ConversationDraft_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 4. Composite tenant foreign keys ────────────────────────────────────────
--
-- Same shape and the same NOT VALID as 20260727140000_composite_tenant_fks: a
-- child row may not point at another tenant's conversation.
--
-- Inert today and deliberately so. Under MATCH SIMPLE a composite key with any
-- NULL column is not checked, and tenantId is NULL everywhere until stamping is
-- switched on. The ordering that matters is in
-- docs/TENANT-ENFORCEMENT-PREREQUISITES.md: Conversation must be backfilled
-- BEFORE writes start stamping, or a stamped note pointing at a NULL-tenant
-- conversation is exactly the failure that broke lead creation on 2026-08-07.
DO $$ BEGIN
  ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_tenantId_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ConversationDraft" ADD CONSTRAINT "ConversationDraft_tenantId_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 5. Row Level Security ───────────────────────────────────────────────────
--
-- Policy shape copied verbatim from 20260727130000_rls_enforce. Required by
-- tests/rlsPolicyCoverage.test.ts, which exists because twenty-seven tables were
-- once added without one and nothing noticed — the app connects as a BYPASSRLS
-- role, so an unprotected table behaves identically until the day it does not.
ALTER TABLE "ConversationNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationNote" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConversationNote_tenant_isolation" ON "ConversationNote";
CREATE POLICY "ConversationNote_tenant_isolation" ON "ConversationNote"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );

ALTER TABLE "ConversationDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationDraft" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConversationDraft_tenant_isolation" ON "ConversationDraft";
CREATE POLICY "ConversationDraft_tenant_isolation" ON "ConversationDraft"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
