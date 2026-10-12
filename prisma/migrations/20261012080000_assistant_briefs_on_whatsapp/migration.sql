-- The assistant sending what it produces on its own (scheduled briefings, watch
-- alerts) to the phone a person linked. Four additive columns, re-runnable.
-- It changes nothing for a workspace where asking the assistant on WhatsApp is
-- off, or for a person with no linked phone.

-- The person's own switch.
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "updatesOnWhatsApp" BOOLEAN NOT NULL DEFAULT true;
-- When a "you have an update" template was last sent to them.
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "nudgedAt" TIMESTAMP(3);
-- When that phone last wrote in as verified staff: WhatsApp's 24 hours run from it.
-- Null for links made before this: nothing is sent freely until they next write.
ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "lastInboundAt" TIMESTAMP(3);
-- When an answer was delivered to WhatsApp. Existing rows stay null and are not
-- sent: only answers from the last 24 hours are ever considered.
ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "whatsappSentAt" TIMESTAMP(3);
