-- =============================================================================
-- IMMUTABLE, HASH-CHAINED SIGNING EVIDENCE
-- =============================================================================
--
-- "SignatureEvent" records who opened a document, who was verified, who signed
-- and when. As an ordinary table, anything holding a connection could edit a
-- timestamp or delete a row and leave no trace. That is a log, not evidence —
-- and in the one moment it matters, "our system says so" is worth exactly as
-- much as the difficulty of editing the table.
--
-- Two properties, both enforced by the database rather than by convention:
--
--   APPEND-ONLY   UPDATE and DELETE are refused outright.
--   HASH-CHAINED  each row carries the hash of the row before it, so removing or
--                 altering an event breaks every link after it. Tampering stops
--                 being invisible and becomes arithmetic that no longer adds up.
--
-- ── Why the content hash is computed by the APPLICATION ─────────────────────
--
-- An earlier draft of this migration digested metadata::jsonb::text inside
-- PostgreSQL. That silently binds the evidence to one server's behaviour: jsonb
-- does not preserve key order (it sorts by length, then bytewise) and the text
-- cast is affected by the session TimeZone. A bundle exported and checked
-- anywhere else — or on a restored backup with a different server setting —
-- would fail to verify through no fault of the evidence, and a chain that breaks
-- for structural reasons is worse than none, because it cannot be told apart
-- from tampering.
--
-- So the row arrives with payloadHash already computed over a canonical form the
-- application controls (sorted keys, fixed field order — see
-- src/lib/signing/evidenceHash.ts, which imports nothing but crypto precisely so
-- a verifier never needs this system to check it). The database owns only the
-- LINKING: position, previous hash, and eventHash = sha256(prevHash||payloadHash).
-- That division is deliberate — the part needing a lock stays in the database,
-- and the part needing to be reproducible elsewhere stays out of it.
-- =============================================================================

SET app.bypass_rls = 'on';

-- Defaults on three of the four ONLY so an ordinary typed insert need not name
-- them; the BEFORE INSERT trigger overwrites all three, so the defaults are
-- never the values stored. INTEGER rather than BIGINT deliberately: a bigint
-- surfaces in the client as a JavaScript BigInt, which does not survive
-- JSON.stringify and has already broken this repository's nightly backup once.
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "sequence" INTEGER DEFAULT 0;
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "prevHash" TEXT DEFAULT '';
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "eventHash" TEXT DEFAULT '';
-- No default: the application must supply it, and the trigger refuses the insert
-- rather than chaining a hash of nothing.
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "payloadHash" TEXT;

-- ── Backfill the existing history --------------------------------------------
--
-- Historic rows are chained in observed order so the chain is unbroken from the
-- first event and verification needs no special case for "before this existed".
--
-- Their payloadHash is a SENTINEL derived from the row id, not a digest of the
-- contents, and that is deliberate rather than a shortcut. PostgreSQL cannot
-- reproduce the application's canonical form (see above), so a hash computed
-- here would disagree with every verifier. And more honestly: these rows were
-- freely editable until this migration ran, so hashing them now would attest to
-- something this system cannot vouch for. What the sentinel still gives is real
-- and sufficient — the links bind, so deleting, reordering or inserting a
-- historic event breaks every hash after it. Field-level tamper detection starts
-- here, which is the only claim the evidence supports.
--
-- Unconditional on purpose. An earlier arrangement had TWO competing chain
-- designs in two migrations; the second backfilled only rows whose eventHash was
-- still empty, so everything the first had already populated was skipped,
-- payloadHash stayed NULL, and the SET NOT NULL below failed on any database
-- holding existing events. It never appeared in CI because CI starts empty.
DO $$
DECLARE request_row RECORD;
DECLARE event_row RECORD;
DECLARE seq INTEGER;
DECLARE prev TEXT;
DECLARE payload TEXT;
BEGIN
  FOR request_row IN
    SELECT DISTINCT "requestId" FROM "SignatureEvent" ORDER BY "requestId"
  LOOP
    seq := 0;
    prev := repeat('0', 64);
    FOR event_row IN
      SELECT "id" FROM "SignatureEvent"
      WHERE "requestId" = request_row."requestId"
      ORDER BY "createdAt", "id"
      FOR UPDATE
    LOOP
      seq := seq + 1;
      payload := encode(digest(convert_to('historic-event:' || event_row."id", 'UTF8'), 'sha256'), 'hex');
      UPDATE "SignatureEvent"
      SET "sequence" = seq,
          "prevHash" = prev,
          "payloadHash" = payload,
          "eventHash" = encode(digest(convert_to(prev || payload, 'UTF8'), 'sha256'), 'hex')
      WHERE "id" = event_row."id";
      prev := encode(digest(convert_to(prev || payload, 'UTF8'), 'sha256'), 'hex');
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE "SignatureEvent" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "prevHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "payloadHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "eventHash" SET NOT NULL;

-- One position per request: two concurrent writers cannot both take position N
-- and leave a chain that verifies two different ways.
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_request_sequence_key"
  ON "SignatureEvent"("requestId", "sequence");

-- ── Position and link every new row ------------------------------------------
--
-- The transaction-scoped advisory lock serialises inserts for ONE request. Two
-- events racing on the same request would otherwise read the same MAX(sequence),
-- compute the same prevHash, and the unique index would reject one — turning a
-- routine race into a failed signature submission. Locking per request keeps
-- unrelated envelopes fully concurrent.
CREATE OR REPLACE FUNCTION signing_chain_event() RETURNS trigger AS $$
DECLARE prior RECORD;
BEGIN
  IF NEW."payloadHash" IS NULL OR NEW."payloadHash" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SignatureEvent must arrive with an application-computed payloadHash';
  END IF;

  -- Derived here as well as in SignatureEvent_stamp_tenant, because same-event
  -- triggers fire in alphabetical order and chain integrity must not depend on
  -- trigger naming.
  IF NEW."tenantId" IS NULL THEN
    SELECT "tenantId" INTO NEW."tenantId" FROM "SignatureRequest" WHERE "id" = NEW."requestId";
  END IF;
  IF NEW."tenantId" IS NULL THEN
    RAISE EXCEPTION 'Cannot chain an event without a tenant-owned request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."requestId", 0));

  SELECT "sequence", "eventHash" INTO prior
  FROM "SignatureEvent"
  WHERE "requestId" = NEW."requestId"
  ORDER BY "sequence" DESC LIMIT 1;

  NEW."sequence" := COALESCE(prior."sequence", 0) + 1;
  NEW."prevHash" := COALESCE(prior."eventHash", repeat('0', 64));
  NEW."eventHash" := encode(digest(convert_to(NEW."prevHash" || NEW."payloadHash", 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureEvent_chain" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_chain"
BEFORE INSERT ON "SignatureEvent" FOR EACH ROW EXECUTE FUNCTION signing_chain_event();

-- ── Append-only ---------------------------------------------------------------
--
-- Note what this makes permanent: a SignatureRequest can no longer be hard
-- deleted, because the FK cascade would have to DELETE its events and this
-- refuses. That is intended — a signing envelope is a business record under a
-- retention obligation, and the application soft-deletes it into Trash rather
-- than removing the row. purgeTrash does not include signature requests.
CREATE OR REPLACE FUNCTION signing_evidence_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SignatureEvent is append-only evidence; append a correcting event instead' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureEvent_immutable" ON "SignatureEvent";
DROP TRIGGER IF EXISTS "SignatureEvent_append_only" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_immutable"
BEFORE UPDATE OR DELETE ON "SignatureEvent" FOR EACH ROW EXECUTE FUNCTION signing_evidence_immutable();

RESET app.bypass_rls;
