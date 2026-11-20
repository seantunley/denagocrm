-- A person's own call-to-action line under their email signature (the Email signatures pack, 2026-11-20: item 10 of
-- email-signature-improvements.md). Additive and nullable: nothing changes until someone fills it in.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureCta" TEXT;
