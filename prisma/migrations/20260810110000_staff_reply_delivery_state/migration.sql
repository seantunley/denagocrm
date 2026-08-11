-- A staff reply is a durable operation, and the inbox has to be able to see how
-- it went.
--
-- Three additions to BotFlowOutbox:
--
--   origin           who composed the message. Human takeover cancels the
--                    AUTOMATION's unsent backlog for a conversation and must not
--                    touch the person's own reply, so the queue has to say which
--                    is which. It is not derivable from actorId, which a bot row
--                    also carries. Every row that existed before this is "bot",
--                    which the default supplies.
--
--   communicationId  the CRM timeline row this delivery is for. Without it the
--                    two halves cannot be joined — the Communication says a
--                    message exists, the outbox knows whether it ever reached the
--                    customer — and the inbox could only ever render the first.
--                    That is how a bubble comes to read "Sent" under a message
--                    the provider rejected eight times. ON DELETE SET NULL: a
--                    deleted timeline row must not delete the delivery record of
--                    a message the customer already received.
--
--   the `cancelled`  no schema change — `status` is free text — but it is new
--   status           behaviour, so it is written down here beside the column.
--                    Distinct from `dead`: one is a decision, the other is a
--                    failure, and an operator looking at a silent conversation
--                    needs to tell them apart.
--
-- Additive and reentrant. No existing row changes meaning: the origin default
-- backfills every historical row as bot output, which is what they all are —
-- staff replies did not go through this queue until now.

ALTER TABLE "BotFlowOutbox" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "BotFlowOutbox" ADD COLUMN IF NOT EXISTS "communicationId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BotFlowOutbox_communicationId_fkey'
  ) THEN
    ALTER TABLE "BotFlowOutbox"
      ADD CONSTRAINT "BotFlowOutbox_communicationId_fkey"
      FOREIGN KEY ("communicationId") REFERENCES "Communication"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- One delivery record per timeline row. Postgres allows repeated NULLs in a
-- unique index, so every row that has no link is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowOutbox_tenantId_communicationId_key"
  ON "BotFlowOutbox" ("tenantId", "communicationId");

-- Human takeover asks for one conversation's unsent BOT rows, and it asks on
-- every staff reply.
CREATE INDEX IF NOT EXISTS "BotFlowOutbox_tenantId_channel_key_origin_status_idx"
  ON "BotFlowOutbox" ("tenantId", "channel", "key", "origin", "status");
