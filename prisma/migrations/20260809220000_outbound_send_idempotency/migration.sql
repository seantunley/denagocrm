-- A manual reply used to call the provider FIRST and write the CRM record after,
-- so a provider success followed by a failed insert left the customer holding a
-- message the CRM had no record of. Staff saw an error, retried, and the customer
-- received it twice. Ordering alone cannot fix that: the send has to be able to
-- recognise a resubmission of the SAME composed message.
--
-- `clientIdempotencyKey` is that identity. It is supplied by the surface that
-- composed the message and held stable across ITS retries, so a resubmission
-- after an ambiguous failure resolves to the row that already exists.
--
-- `failureCode` sits beside the human-readable `lastError` so a retry policy can
-- distinguish a permanently invalid recipient from a transient provider outage.
--
-- Every statement is reentrant, so re-applying this migration is a no-op.

ALTER TABLE "BotFlowOutbox" ADD COLUMN IF NOT EXISTS "clientIdempotencyKey" TEXT;
ALTER TABLE "BotFlowOutbox" ADD COLUMN IF NOT EXISTS "failureCode" TEXT;

-- Partial: NULLs are distinct in Postgres unique indexes anyway, and every row
-- written before this migration has none. Bot-authored sends continue to leave it
-- empty, so they neither collide with each other nor with a staff reply.
CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowOutbox_tenantId_clientIdempotencyKey_key"
  ON "BotFlowOutbox" ("tenantId", "clientIdempotencyKey");
