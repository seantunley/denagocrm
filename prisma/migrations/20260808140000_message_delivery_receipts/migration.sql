-- =============================================================================
-- DELIVERY AND READ RECEIPTS FOR OUTBOUND MESSAGES
-- =============================================================================
--
-- Two nullable timestamps on Communication: when the platform said an outbound
-- message reached the customer's device, and when they opened it.
--
-- Deliberately NOT reusing `readAt`. That column already exists and means the
-- opposite thing — when OUR staff first opened an INBOUND message. Two names that
-- look alike and mean opposite directions is how a timeline ends up confidently
-- wrong, so the new state gets its own columns.
--
-- Both are watermark-derived. A Messenger read event carries one timestamp
-- meaning "everything up to here has been seen" and no message ids at all, so
-- per-message precision is not something the platform offers. See
-- src/lib/deliveryReceipts.ts.
--
-- Additive: two nullable columns and one index. Nothing is dropped, nothing is
-- made NOT NULL, and no existing row changes.

ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "seenAt"      TIMESTAMP(3);

-- The receipt update selects by contact + channel + direction, bounded by time.
-- Without this it is a sequential scan of every message on every webhook event,
-- and a busy conversation produces a receipt per message.
CREATE INDEX IF NOT EXISTS "Communication_receipt_idx"
  ON "Communication" ("contactId", "type", "direction", "occurredAt");
