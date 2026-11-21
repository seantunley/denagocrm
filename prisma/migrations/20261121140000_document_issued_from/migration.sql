-- A warranty certificate remembers what it was made from (review of #1174): a fingerprint of the owner, the vehicle
-- and its cover. Additive, nullable; nothing reads it except the certificate checks.
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "issuedFrom" TEXT;
