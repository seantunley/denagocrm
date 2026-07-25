-- Claim-lease timestamp for SignatureRecipient's pending→sending claim.
-- Lets recoverStaleSigningClaims (src/lib/signing/dispatch.ts) detect a claim
-- that crashed or timed out before its finalize update ran, without touching
-- rows a concurrent decline/withdrawal has already moved off "sending".
ALTER TABLE "SignatureRecipient" ADD COLUMN "sendingAt" TIMESTAMP(3);
