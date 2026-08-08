-- A signing job is WORK, not evidence, and should not be what refuses a delete.
--
-- SigningJob's foreign key was created ON DELETE RESTRICT. That is the wrong
-- rule for a queue: the rows are inserted by database triggers, nothing in the
-- application knows they exist, they are never removed once completed, and
-- every other child of SignatureRequest in schema.prisma cascades.
--
-- What it actually changes is WHICH rule speaks. A SignatureRequest carrying
-- evidence is not deletable either way — SignatureEvent is append-only and its
-- trigger refuses DELETE as well as UPDATE, which is a deliberate retention
-- decision — but with RESTRICT here the attempt failed against an internal queue
-- table first:
--
--   Foreign key constraint violated on the constraint: `SigningJob_request_fkey`
--
-- instead of the rule that genuinely applies:
--
--   SignatureEvent is append-only evidence; append a correcting event instead
--
-- The first sends you reading the job queue; the second tells you the truth. A
-- refusal that names the wrong reason costs someone an afternoon.
--
-- Custody is untouched: LegalArtifact and LegalArtifactValidation keep RESTRICT,
-- because a sealed contract's custody record SHOULD block removal of the request
-- it belongs to.
--
-- Replay-safe: DROP IF EXISTS then ADD, so re-running after an interrupted
-- deploy converges rather than failing.

ALTER TABLE "SigningJob" DROP CONSTRAINT IF EXISTS "SigningJob_request_fkey";

DO $$ BEGIN
  ALTER TABLE "SigningJob" ADD CONSTRAINT "SigningJob_request_fkey"
    FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
