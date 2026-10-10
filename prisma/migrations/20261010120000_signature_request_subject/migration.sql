-- Sign anything, first step (Sean, 2026-10-09): a signature request can be about
-- something other than a quote or a job card — first, a test drive's indemnity.
--
--   subjectType / subjectId   what the request is about. No foreign key: the pair
--                             can name any table, so the code that acts on it
--                             checks that row's workspace against the request's.
--   contextJson               that record's values, frozen when the request is
--                             made, so the document a customer signs cannot
--                             change underneath them.
--
-- Additive and re-runnable. Every existing row keeps NULL in all three, and a
-- request with NULL in all three behaves exactly as it did before.

ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "subjectType" TEXT;
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "subjectId" TEXT;
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "contextJson" JSONB;

CREATE INDEX IF NOT EXISTS "SignatureRequest_subjectType_subjectId_idx" ON "SignatureRequest"("subjectType", "subjectId");
