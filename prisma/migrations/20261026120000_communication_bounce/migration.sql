-- Bounced email (Sean, 2026-10-26: a quote to an MWEB customer was refused as
-- "550 High probability of spam" and nobody in the CRM knew). When the mail
-- server's failure notice comes back to the CRM's mailbox, the sent email is
-- stamped with when it bounced and the server's reason (lib/emailBounce.ts).
-- Additive only; re-runnable.

ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "bouncedAt" TIMESTAMP(3);
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "bounceReason" TEXT;
-- When the sender was told. Null while an alert is owed, so a failed push is retried.
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "bounceNotifiedAt" TIMESTAMP(3);
