-- Who owns a conversation, recorded separately from whether the bot is waiting.
--
-- `status` carried both meanings and `paused` was ambiguous: it meant "the bot
-- handed off" AND "a staff member took this over". Because the runtime treated
-- any of menu|hi|hello|hey|start|restart|begin as a restart, a customer typing
-- "hi" while a salesperson was mid-conversation brought the bot back and
-- restarted the flow on top of them.
--
-- `delivery_failed` is the third case: the last outbound message exhausted its
-- retries, so the customer never saw it and the stored node is a prompt that does
-- not exist for them.
ALTER TABLE "BotSession"
  ADD COLUMN "ownership" TEXT NOT NULL DEFAULT 'bot';

-- Existing paused rows are classified as bot handoffs, not human takeovers.
--
-- This is the LESS restrictive of the two, and it is the right default here: the
-- states are indistinguishable in the old data, sessions expire within hours, and
-- classifying them all as `human` would strand every conversation that is
-- genuinely waiting on the bot with no way for the customer to continue. A
-- handoff misread as a takeover is a silent dead end; a takeover misread as a
-- handoff still requires the customer to type an explicit "menu"/"restart", which
-- is a far narrower hole than the greeting that exists today, and it closes as
-- soon as these rows expire.
UPDATE "BotSession" SET "ownership" = 'ai_handoff' WHERE "status" = 'paused';

CREATE INDEX "BotSession_tenant_ownership_idx" ON "BotSession"("tenantId", "ownership");
