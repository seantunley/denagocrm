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
-- Reentrant. The migration runner (scripts/apply-migrations.mjs) opens NO
-- transaction and issues statements one at a time in autocommit, so a
-- statement_timeout or a dropped connection leaves a file half-applied and
-- UNRECORDED — and the next deploy re-runs it from the top. A bare ADD COLUMN
-- would then hit 42701 and wedge the deploy, which is the hand-DDL repair this
-- project has already had to do once.
ALTER TABLE "BotSession"
  ADD COLUMN IF NOT EXISTS "ownership" TEXT NOT NULL DEFAULT 'bot';

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
--
-- `AND "ownership" = 'bot'` is what makes re-running this SAFE, and it is not a
-- micro-optimisation. Without it, a second run once the feature is live rewrites
-- every conversation a salesperson currently owns (`ownership = 'human'`, which
-- is stored with `status = 'paused'`) back to `ai_handoff` — handing live
-- customer threads back to the bot underneath the person holding them. Given the
-- runner has no transaction and a partially applied file gets re-run from the
-- top, that is a realistic sequence, not a hypothetical one.
--
-- Restricting to the column's own default also makes the intent exact: classify
-- rows that have never been classified, and touch nothing else.
UPDATE "BotSession"
   SET "ownership" = 'ai_handoff'
 WHERE "status" = 'paused'
   AND "ownership" = 'bot';

CREATE INDEX IF NOT EXISTS "BotSession_tenant_ownership_idx" ON "BotSession"("tenantId", "ownership");
