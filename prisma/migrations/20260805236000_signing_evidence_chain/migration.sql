-- =============================================================================
-- SIGNING EVIDENCE BECOMES EVIDENCE
-- =============================================================================
--
-- "SignatureEvent" is the record of who opened a document, who was verified, who
-- signed and when. Until now it was an ordinary table: anything holding a
-- database connection could UPDATE a timestamp or DELETE a row and leave no
-- trace of having done so. That is a log, not evidence — and in the one moment
-- it matters, a signer disputing that they signed, "our system says so" is worth
-- exactly as much as the difficulty of editing the table.
--
-- Two properties, both enforced by the database rather than by convention:
--
--   APPEND-ONLY   UPDATE and DELETE are refused outright.
--   HASH-CHAINED  every row carries the hash of the row before it, so removing
--                 or altering an event anywhere in a request's history breaks
--                 every link after it. Tampering stops being invisible; it
--                 becomes arithmetic that no longer adds up.
--
-- Ported from the alternative hardening branch (PR #335), which got this part
-- right, with one deliberate change: the payload is serialised by the
-- APPLICATION and passed in, not assembled from jsonb inside PostgreSQL. The
-- other branch hashed a jsonb_build_object(...)::text built in the database,
-- which silently makes the chain depend on PostgreSQL's exact JSON key ordering,
-- numeric formatting and the session TimeZone. Verification then has to
-- reproduce a PostgreSQL serialisation byte for byte — including from a restored
-- backup on a server whose timezone happens to differ. This computes the digest
-- over a canonical string the application controls, so the chain can be verified
-- anywhere by anything.
-- =============================================================================

SET app.bypass_rls = 'on';

-- sequence/prevHash/eventHash carry defaults ONLY so an ordinary typed insert
-- does not have to name them: the BEFORE INSERT trigger below overwrites all
-- three authoritatively, so the default values are never the ones stored. They
-- are INTEGER rather than BIGINT deliberately — a bigint column surfaces in the
-- client as a JavaScript BigInt, which does not survive JSON.stringify and has
-- already broken this repository's nightly backup once.
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "sequence" INTEGER DEFAULT 0;
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "prevHash" TEXT DEFAULT '';
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "eventHash" TEXT DEFAULT '';
-- No default: the application must supply it, and the trigger refuses the insert
-- if it is missing rather than chaining a hash of nothing.
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "payloadHash" TEXT;

-- ── Backfill the existing history --------------------------------------------
--
-- Historic rows are chained in their observed order, so the chain is unbroken
-- from the first event onwards and verification needs no special case for
-- "before this existed". Ordered by (createdAt, id) so a replay produces an
-- identical chain.
--
-- Their payloadHash is a SENTINEL derived from the row id, not a digest of the
-- row's contents, and that is deliberate rather than a shortcut.
--
-- The application computes a content hash over canonical JSON with sorted keys.
-- PostgreSQL cannot reproduce that string: jsonb orders object keys by length
-- and then bytewise, which is not lexicographic, so a hash computed here would
-- disagree with the one computed by any verifier reading the row back through
-- the client. A chain that fails to verify for structural reasons is worse than
-- no chain, because it cannot be told apart from tampering.
--
-- More honestly: these rows were freely editable until this migration ran, so
-- hashing their contents now would attest to something this system cannot
-- actually vouch for. What the sentinel does give is real and sufficient — the
-- links still bind, so deleting, reordering or inserting a historic event still
-- breaks every hash after it. Field-level tamper detection starts here, which is
-- the only claim the evidence supports.
DO $$
DECLARE request_row RECORD;
DECLARE event_row RECORD;
DECLARE prior TEXT;
DECLARE seq INTEGER;
DECLARE payload_hash TEXT;
BEGIN
  FOR request_row IN
    SELECT DISTINCT "requestId" FROM "SignatureEvent" WHERE "eventHash" IS NULL OR "eventHash" = '' ORDER BY "requestId"
  LOOP
    prior := repeat('0', 64);
    seq := 0;
    FOR event_row IN
      SELECT "id" FROM "SignatureEvent"
      WHERE "requestId" = request_row."requestId"
      ORDER BY "createdAt", "id"
    LOOP
      seq := seq + 1;
      payload_hash := encode(digest(convert_to('historic-event:' || event_row."id", 'UTF8'), 'sha256'), 'hex');
      UPDATE "SignatureEvent"
      SET "sequence" = seq,
          "prevHash" = prior,
          "payloadHash" = payload_hash,
          "eventHash" = encode(digest(convert_to(prior || payload_hash, 'UTF8'), 'sha256'), 'hex')
      WHERE "id" = event_row."id";
      prior := encode(digest(convert_to(prior || payload_hash, 'UTF8'), 'sha256'), 'hex');
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE "SignatureEvent" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "prevHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "payloadHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "eventHash" SET NOT NULL;

-- One sequence number per request, so two concurrent writers cannot both take
-- position N and leave a chain that verifies two different ways.
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_request_sequence_key"
  ON "SignatureEvent"("requestId", "sequence");

-- ── Position and link every new row ------------------------------------------
--
-- The transaction-scoped advisory lock serialises inserts for ONE request only.
-- Without it two events racing on the same request read the same MAX(sequence),
-- both compute the same prevHash, and the unique index rejects one of them —
-- turning a routine race into a failed signature submission. Locking per request
-- rather than per table keeps unrelated envelopes fully concurrent.
CREATE OR REPLACE FUNCTION signing_event_chain() RETURNS trigger AS $$
DECLARE previous_hash TEXT;
DECLARE next_sequence BIGINT;
BEGIN
  IF NEW."payloadHash" IS NULL THEN
    RAISE EXCEPTION 'SignatureEvent must arrive with an application-computed payloadHash';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."requestId", 0));

  SELECT COALESCE(MAX("sequence"), 0) + 1 INTO next_sequence
  FROM "SignatureEvent" WHERE "requestId" = NEW."requestId";

  SELECT "eventHash" INTO previous_hash
  FROM "SignatureEvent" WHERE "requestId" = NEW."requestId"
  ORDER BY "sequence" DESC LIMIT 1;

  NEW."sequence" := next_sequence;
  NEW."prevHash" := COALESCE(previous_hash, repeat('0', 64));
  NEW."eventHash" := encode(digest(convert_to(NEW."prevHash" || NEW."payloadHash", 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureEvent_chain" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_chain"
BEFORE INSERT ON "SignatureEvent"
FOR EACH ROW EXECUTE FUNCTION signing_event_chain();

-- ── Append-only ---------------------------------------------------------------
--
-- Note what this makes permanent: a SignatureRequest can no longer be hard
-- deleted, because the FK cascade would have to DELETE its events and this
-- refuses. That is intended — a signing envelope is a business record under a
-- retention obligation, and the application already soft-deletes it into Trash
-- rather than removing the row. purgeTrash does not include signature requests.
CREATE OR REPLACE FUNCTION signing_evidence_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only evidence and cannot be % once written',
    TG_TABLE_NAME, lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureEvent_append_only" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_append_only"
BEFORE UPDATE OR DELETE ON "SignatureEvent"
FOR EACH ROW EXECUTE FUNCTION signing_evidence_is_append_only();

RESET app.bypass_rls;
