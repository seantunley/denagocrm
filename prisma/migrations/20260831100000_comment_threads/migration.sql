-- Comment threads in the Social Inbox.
--
-- DATE-STAMPED, NOT NUMBERED, AND THAT MATTERS. apply-migrations.mjs orders by
-- true NUMERIC prefix, so the date-stamped tenancy migrations (20260722…,
-- 20260727…) sort AFTER every small number. `Conversation."tenantId"` is added
-- by 20260722144000_tenant_inbox_isolation, so this file named "83_" ran BEFORE
-- that column existed and the unique index below failed with 42703 on any fresh
-- database — CI, preview, and disaster recovery. Production survives it only
-- because the column is already there. Anything touching a tenant column has to
-- carry a timestamp later than the tenancy work.
--
-- A DM thread is one customer. A COMMENT thread is one POST — many people, most
-- of whom the CRM has never met, because a commenter's Facebook id is not their
-- Messenger id and cannot be matched to an existing contact. So a comment thread
-- is keyed by the post it belongs to rather than by a person, and
-- `externalRef` is where that key lives ("facebook:<postId>").
--
-- `mutedAt` exists because a Page `feed` subscription is Page-wide: one busy
-- campaign could otherwise bury an inbox that works well today. Muting is
-- per-post so the noisy one can be silenced without going blind to the rest.
--
-- Additive and empty on arrival: every existing conversation is about a person
-- and leaves both columns NULL, which is also why the unique index below
-- constrains nothing that exists today — Postgres treats NULLs as distinct, so
-- only rows that actually set `externalRef` participate.

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "externalRef" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "mutedAt" TIMESTAMP(3);

-- One thread per external object per workspace. This is what makes the
-- find-or-create safe when two comments arrive at once on a post that has no
-- thread yet: the loser of the race gets a unique violation and re-reads,
-- instead of both winning and splitting the post across two threads.
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_tenantId_channel_externalRef_key"
  ON "Conversation" ("tenantId", "channel", "externalRef");
