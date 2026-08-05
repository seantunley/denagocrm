-- =============================================================================
-- IMMUTABLE, HASH-CHAINED SIGNING EVIDENCE
-- =============================================================================
SET app.bypass_rls = 'on';

ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "sequence" INTEGER;
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "previousHash" TEXT;
ALTER TABLE "SignatureEvent" ADD COLUMN IF NOT EXISTS "eventHash" TEXT;

-- Backfill each request deterministically. The chain commits the complete event
-- payload and the previous digest; changing or removing any historical row makes
-- every later verification fail.
DO $$
DECLARE request_row RECORD;
DECLARE event_row RECORD;
DECLARE seq INTEGER;
DECLARE prev TEXT;
DECLARE digest_value TEXT;
BEGIN
  FOR request_row IN
    SELECT DISTINCT "tenantId", "requestId" FROM "SignatureEvent"
    ORDER BY "tenantId", "requestId"
  LOOP
    seq := 0;
    prev := NULL;
    FOR event_row IN
      SELECT * FROM "SignatureEvent"
      WHERE "tenantId" = request_row."tenantId" AND "requestId" = request_row."requestId"
      ORDER BY "createdAt", "id"
      FOR UPDATE
    LOOP
      seq := seq + 1;
      digest_value := encode(digest(
        concat_ws('|',
          request_row."tenantId",
          event_row."requestId",
          event_row."id",
          seq::text,
          COALESCE(prev, ''),
          COALESCE(event_row."recipientId", ''),
          event_row."type",
          event_row."actor",
          COALESCE(event_row."channel", ''),
          COALESCE(event_row."ip", ''),
          COALESCE(event_row."userAgent", ''),
          COALESCE(event_row."metadata"::jsonb::text, ''),
          event_row."createdAt"::text
        ), 'sha256'
      ), 'hex');
      UPDATE "SignatureEvent"
      SET "sequence" = seq, "previousHash" = prev, "eventHash" = digest_value
      WHERE "id" = event_row."id";
      prev := digest_value;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE "SignatureEvent" ALTER COLUMN "sequence" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "eventHash" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_tenant_request_sequence_key"
  ON "SignatureEvent"("tenantId", "requestId", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_eventHash_key"
  ON "SignatureEvent"("eventHash");

CREATE OR REPLACE FUNCTION signing_chain_event() RETURNS trigger AS $$
DECLARE prior RECORD;
BEGIN
  -- Serialize only this request's evidence stream, including the first event.
  PERFORM pg_advisory_xact_lock(hashtext(NEW."tenantId" || ':' || NEW."requestId")::bigint);
  SELECT "sequence", "eventHash" INTO prior
  FROM "SignatureEvent"
  WHERE "tenantId" = NEW."tenantId" AND "requestId" = NEW."requestId"
  ORDER BY "sequence" DESC LIMIT 1;

  NEW."sequence" := COALESCE(prior."sequence", 0) + 1;
  NEW."previousHash" := prior."eventHash";
  NEW."eventHash" := encode(digest(
    concat_ws('|',
      NEW."tenantId",
      NEW."requestId",
      NEW."id",
      NEW."sequence"::text,
      COALESCE(NEW."previousHash", ''),
      COALESCE(NEW."recipientId", ''),
      NEW."type",
      NEW."actor",
      COALESCE(NEW."channel", ''),
      COALESCE(NEW."ip", ''),
      COALESCE(NEW."userAgent", ''),
      COALESCE(NEW."metadata"::jsonb::text, ''),
      NEW."createdAt"::text
    ), 'sha256'
  ), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureEvent_chain" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_chain"
BEFORE INSERT ON "SignatureEvent" FOR EACH ROW EXECUTE FUNCTION signing_chain_event();

CREATE OR REPLACE FUNCTION signing_evidence_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SignatureEvent is immutable; append a correcting event instead' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureEvent_immutable" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_immutable"
BEFORE UPDATE OR DELETE ON "SignatureEvent" FOR EACH ROW EXECUTE FUNCTION signing_evidence_immutable();

RESET app.bypass_rls;
