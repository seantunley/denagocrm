-- Hash-chained append-only evidence and immutable legal custody.

CREATE OR REPLACE FUNCTION signing_event_prepare() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE previous_hash text;
DECLARE next_sequence bigint;
DECLARE payload text;
DECLARE owner_tenant text;
BEGIN
  SELECT "tenantId" INTO owner_tenant FROM "SignatureRequest" WHERE id=NEW."requestId";
  IF owner_tenant IS NULL THEN RAISE EXCEPTION 'SignatureEvent has no owning envelope'; END IF;
  IF NEW."tenantId" IS NULL THEN NEW."tenantId" := owner_tenant; END IF;
  IF NEW."tenantId"<>owner_tenant THEN RAISE EXCEPTION 'Cross-tenant evidence event refused'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."requestId",0));
  SELECT COALESCE(MAX(sequence),0)+1,
         COALESCE((array_agg("eventHash" ORDER BY sequence DESC))[1],repeat('0',64))
    INTO next_sequence,previous_hash
    FROM "SignatureEvent" WHERE "requestId"=NEW."requestId";
  NEW.sequence := next_sequence;
  NEW."prevHash" := previous_hash;
  NEW."releaseId" := COALESCE(NEW."releaseId",NULLIF(NEW.metadata->>'releaseId',''),'unknown');
  payload := jsonb_build_object(
    'id',NEW.id,'tenantId',NEW."tenantId",'requestId',NEW."requestId",'recipientId',NEW."recipientId",
    'sequence',NEW.sequence,'type',NEW.type,'actor',NEW.actor,'channel',NEW.channel,'ip',NEW.ip,
    'userAgent',NEW."userAgent",'metadata',COALESCE(NEW.metadata,'{}'::jsonb),'createdAt',NEW."createdAt",
    'producer',NEW.producer,'releaseId',NEW."releaseId",'schemaVersion',NEW."schemaVersion"
  )::text;
  NEW."payloadHash" := encode(digest(convert_to(payload,'UTF8'),'sha256'),'hex');
  NEW."eventHash" := encode(digest(NEW."prevHash"||NEW."payloadHash",'sha256'),'hex');
  RETURN NEW;
END $$;

-- Backfill existing evidence in deterministic order before enabling NOT NULL.
DO $$
DECLARE request_row record;
DECLARE event_row record;
DECLARE prior text;
DECLARE seq bigint;
DECLARE payload text;
BEGIN
  FOR request_row IN SELECT DISTINCT "requestId" FROM "SignatureEvent" ORDER BY "requestId" LOOP
    prior := repeat('0',64); seq := 0;
    FOR event_row IN SELECT * FROM "SignatureEvent" WHERE "requestId"=request_row."requestId" ORDER BY "createdAt",id LOOP
      seq := seq+1;
      payload := jsonb_build_object(
        'id',event_row.id,'tenantId',event_row."tenantId",'requestId',event_row."requestId",'recipientId',event_row."recipientId",
        'sequence',seq,'type',event_row.type,'actor',event_row.actor,'channel',event_row.channel,'ip',event_row.ip,
        'userAgent',event_row."userAgent",'metadata',COALESCE(event_row.metadata,'{}'::jsonb),'createdAt',event_row."createdAt",
        'producer',COALESCE(event_row.producer,'denagocrm'),'releaseId',COALESCE(event_row."releaseId",event_row.metadata->>'releaseId','historic-migration'),
        'schemaVersion',COALESCE(event_row."schemaVersion",1)
      )::text;
      UPDATE "SignatureEvent" SET sequence=seq,"prevHash"=prior,
        "payloadHash"=encode(digest(convert_to(payload,'UTF8'),'sha256'),'hex'),
        "eventHash"=encode(digest(prior||encode(digest(convert_to(payload,'UTF8'),'sha256'),'hex'),'sha256'),'hex'),
        "releaseId"=COALESCE(event_row."releaseId",event_row.metadata->>'releaseId','historic-migration')
      WHERE id=event_row.id;
      SELECT "eventHash" INTO prior FROM "SignatureEvent" WHERE id=event_row.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE "SignatureEvent" ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "prevHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "payloadHash" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "eventHash" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_request_sequence_key" ON "SignatureEvent"("requestId",sequence);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureEvent_request_hash_key" ON "SignatureEvent"("requestId","eventHash");

DROP TRIGGER IF EXISTS "SignatureEvent_prepare_hash" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_prepare_hash" BEFORE INSERT ON "SignatureEvent"
FOR EACH ROW EXECUTE FUNCTION signing_event_prepare();

CREATE OR REPLACE FUNCTION signing_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME; END $$;

DROP TRIGGER IF EXISTS "SignatureEvent_no_update" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_no_update" BEFORE UPDATE OR DELETE ON "SignatureEvent"
FOR EACH ROW EXECUTE FUNCTION signing_refuse_mutation();
DROP TRIGGER IF EXISTS "SigningEvidenceAnchor_no_update" ON "SigningEvidenceAnchor";
CREATE TRIGGER "SigningEvidenceAnchor_no_update" BEFORE UPDATE OR DELETE ON "SigningEvidenceAnchor"
FOR EACH ROW EXECUTE FUNCTION signing_refuse_mutation();
DROP TRIGGER IF EXISTS "SigningRecoveryAction_no_update" ON "SigningRecoveryAction";
CREATE TRIGGER "SigningRecoveryAction_no_update" BEFORE UPDATE OR DELETE ON "SigningRecoveryAction"
FOR EACH ROW EXECUTE FUNCTION signing_refuse_mutation();

CREATE OR REPLACE FUNCTION signing_legal_artifact_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LegalArtifact cannot be deleted'; END IF;
  IF NEW."tenantId"<>OLD."tenantId" OR NEW."envelopeId"<>OLD."envelopeId"
     OR NEW."artifactVersion"<>OLD."artifactVersion" OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."objectRef"<>OLD."objectRef" OR NEW.sha256<>OLD.sha256 OR NEW."sizeBytes"<>OLD."sizeBytes"
     OR NEW."certificateFingerprint"<>OLD."certificateFingerprint"
     OR NEW."certificateChainJson"<>OLD."certificateChainJson"
     OR NEW."keyId" IS DISTINCT FROM OLD."keyId" OR NEW."trustPolicy"<>OLD."trustPolicy"
     OR NEW."timestampTokenRef" IS DISTINCT FROM OLD."timestampTokenRef"
     OR NEW."validationReportJson"<>OLD."validationReportJson"
     OR NEW."retentionClass"<>OLD."retentionClass" OR NEW."retainUntil"<>OLD."retainUntil"
  THEN RAISE EXCEPTION 'Immutable legal evidence fields cannot be changed'; END IF;
  IF OLD."destroyedAt" IS NOT NULL THEN RAISE EXCEPTION 'Destroyed legal artifact record is immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "LegalArtifact_guard" ON "LegalArtifact";
CREATE TRIGGER "LegalArtifact_guard" BEFORE UPDATE OR DELETE ON "LegalArtifact"
FOR EACH ROW EXECUTE FUNCTION signing_legal_artifact_guard();

CREATE OR REPLACE FUNCTION signing_protect_filed_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LegalArtifact" WHERE "documentId"=OLD.id AND "destroyedAt" IS NULL) THEN
    RAISE EXCEPTION 'Document is an active immutable legal artifact';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS "Document_protect_legal_artifact" ON "Document";
CREATE TRIGGER "Document_protect_legal_artifact" BEFORE UPDATE OF "deletedAt","storedName" OR DELETE ON "Document"
FOR EACH ROW EXECUTE FUNCTION signing_protect_filed_document();
