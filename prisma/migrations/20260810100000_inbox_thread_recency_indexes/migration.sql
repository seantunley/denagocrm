-- Inbox thread selection reads Communication BY THREAD, and had no index for it.
--
-- Choosing conversations by recency asks two questions the old "newest 400 rows"
-- slice never asked: the newest occurredAt per (contactId, type) and per
-- (leadId, type), and then the newest N rows WITHIN one such thread. Every one of
-- those is a scan of the whole table without a matching index — the table has
-- indexes on archivedAt, tenantId, conversationId and messageId, and none on the
-- two columns a thread is actually keyed by.
--
-- The sidebar's unread badge asks the same two aggregates, on every page render.
--
-- DESC on occurredAt matches how all three read it: newest first. Postgres can
-- scan a b-tree backwards, so ASC would also work — naming the direction just
-- keeps the index and the query in the same order, which matters for the
-- per-thread ROW_NUMBER ordering.
--
-- Additive: two indexes. No column, constraint or row is touched. Reentrant, so
-- re-running against a database that already has them is a no-op.

CREATE INDEX IF NOT EXISTS "Communication_contact_thread_idx"
  ON "Communication" ("contactId", "type", "occurredAt" DESC);

CREATE INDEX IF NOT EXISTS "Communication_lead_thread_idx"
  ON "Communication" ("leadId", "type", "occurredAt" DESC);
