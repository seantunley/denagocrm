-- DAX updates outside WhatsApp's 24 hours, carried IN a template (Sean,
-- 2026-10-20: Donovan's reminder ran on time but sat behind "tap to read it").
-- When Meta last refused that template, so it is not retried every half hour.
-- Additive only; re-runnable.

ALTER TABLE "AssistantPhoneLink" ADD COLUMN IF NOT EXISTS "contentTemplateRefusedAt" TIMESTAMP(3);
