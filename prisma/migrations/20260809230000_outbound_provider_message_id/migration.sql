-- Meta echoes every message the Page sends back to the webhook, including the
-- ones we sent ourselves. Recording each echo unconditionally wrote a SECOND
-- outbound row for a message the CRM had already logged, so one real customer
-- message appeared twice in history.
--
-- The provider's own id for the accepted send is what tells them apart. Keeping
-- it on the delivery ledger also gives receipts and failures something exact to
-- correlate against, instead of a conversation-level watermark that cannot say
-- WHICH message it refers to.
--
-- Reentrant: re-applying this migration is a no-op.

ALTER TABLE "BotFlowOutbox" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;

-- Deliberately NOT unique. Providers can legitimately reuse or re-report an id
-- across retries, and a unique index would turn that into a delivery failure.
-- The echo check only needs to answer "have we seen this id", which an index
-- answers without constraining it.
CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenantId_providerMessageId_idx"
  ON "BotFlowOutbox" ("tenantId", "providerMessageId");
