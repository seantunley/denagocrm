-- Database-enforced tenant stamping, state transitions and durable outbox.

CREATE OR REPLACE FUNCTION signing_current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_tenant',true),'') $$;

CREATE OR REPLACE FUNCTION signing_stamp_request_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS NULL THEN NEW."tenantId" := signing_current_tenant(); END IF;
  IF NEW."tenantId" IS NULL THEN RAISE EXCEPTION 'SignatureRequest requires tenant scope'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "SignatureRequest_stamp_tenant" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_stamp_tenant" BEFORE INSERT ON "SignatureRequest"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_request_tenant();

CREATE OR REPLACE FUNCTION signing_stamp_child_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE owner_tenant text;
BEGIN
  SELECT "tenantId" INTO owner_tenant FROM "SignatureRequest" WHERE id=NEW."requestId";
  IF owner_tenant IS NULL THEN RAISE EXCEPTION 'Signing child has no owning envelope'; END IF;
  IF NEW."tenantId" IS NULL THEN NEW."tenantId" := owner_tenant; END IF;
  IF NEW."tenantId" <> owner_tenant THEN RAISE EXCEPTION 'Cross-tenant signing relationship refused'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SignatureRecipient_stamp_tenant" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_stamp_tenant" BEFORE INSERT OR UPDATE OF "requestId","tenantId" ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_child_tenant();
DROP TRIGGER IF EXISTS "SignatureField_stamp_tenant" ON "SignatureField";
CREATE TRIGGER "SignatureField_stamp_tenant" BEFORE INSERT OR UPDATE OF "requestId","tenantId" ON "SignatureField"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_child_tenant();
DROP TRIGGER IF EXISTS "SignatureEvent_stamp_tenant" ON "SignatureEvent";
CREATE TRIGGER "SignatureEvent_stamp_tenant" BEFORE INSERT ON "SignatureEvent"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_child_tenant();
DROP TRIGGER IF EXISTS "ApprovalStep_stamp_tenant" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_stamp_tenant" BEFORE INSERT OR UPDATE OF "requestId","tenantId" ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_child_tenant();

CREATE OR REPLACE FUNCTION signing_stamp_response_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE field_tenant text;
DECLARE recipient_tenant text;
BEGIN
  SELECT "tenantId" INTO field_tenant FROM "SignatureField" WHERE id=NEW."fieldId";
  SELECT "tenantId" INTO recipient_tenant FROM "SignatureRecipient" WHERE id=NEW."recipientId";
  IF field_tenant IS NULL OR recipient_tenant IS NULL OR field_tenant<>recipient_tenant THEN
    RAISE EXCEPTION 'Cross-tenant signature response refused';
  END IF;
  IF NEW."tenantId" IS NULL THEN NEW."tenantId" := field_tenant; END IF;
  IF NEW."tenantId"<>field_tenant THEN RAISE EXCEPTION 'Cross-tenant signature response refused'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "SignatureFieldResponse_stamp_tenant" ON "SignatureFieldResponse";
CREATE TRIGGER "SignatureFieldResponse_stamp_tenant" BEFORE INSERT OR UPDATE OF "fieldId","recipientId","tenantId" ON "SignatureFieldResponse"
FOR EACH ROW EXECUTE FUNCTION signing_stamp_response_tenant();

CREATE OR REPLACE FUNCTION signing_validate_request_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE allowed boolean := false;
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF OLD.status IN ('completed','declined','voided','expired','rejected','failed_manual_intervention') THEN
    RAISE EXCEPTION 'Terminal signing state % cannot transition to %',OLD.status,NEW.status;
  END IF;
  allowed := CASE OLD.status
    WHEN 'draft' THEN NEW.status IN ('prepared','sending','sent','in_progress','voided','failed_manual_intervention')
    WHEN 'prepared' THEN NEW.status IN ('dispatching','active','sent','viewed','in_progress','signing','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'sending' THEN NEW.status IN ('draft','sent','active','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'dispatching' THEN NEW.status IN ('prepared','active','sent','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'active' THEN NEW.status IN ('viewed','sent','in_progress','signing','signatures_complete','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'sent' THEN NEW.status IN ('viewed','in_progress','signing','signatures_complete','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'viewed' THEN NEW.status IN ('sent','in_progress','signing','signatures_complete','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'in_progress' THEN NEW.status IN ('sent','viewed','signing','signatures_complete','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'signing' THEN NEW.status IN ('sent','viewed','in_progress','signatures_complete','rendering','voided','declined','expired','rejected','failed_manual_intervention')
    WHEN 'signatures_complete' THEN NEW.status IN ('rendering','failed_manual_intervention')
    WHEN 'rendering' THEN NEW.status IN ('signatures_complete','sealed','failed_manual_intervention')
    WHEN 'sealed' THEN NEW.status IN ('distributing','completed','failed_manual_intervention')
    WHEN 'distributing' THEN NEW.status IN ('completed','failed_manual_intervention')
    ELSE false
  END;
  IF NOT allowed THEN RAISE EXCEPTION 'Invalid signing transition % -> %',OLD.status,NEW.status; END IF;
  NEW."stateVersion" := OLD."stateVersion"+1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "SignatureRequest_validate_transition" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_validate_transition" BEFORE UPDATE OF status ON "SignatureRequest"
FOR EACH ROW EXECUTE FUNCTION signing_validate_request_transition();

CREATE OR REPLACE FUNCTION signing_enqueue_job(
  tenant_id text,envelope_id text,recipient_id text,job_type text,payload jsonb,
  idempotency_key text,available_at timestamptz DEFAULT now()
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "SigningOutboxJob"("tenantId","envelopeId","recipientId","jobType",payload,"idempotencyKey","availableAt")
  VALUES (tenant_id,envelope_id,recipient_id,job_type,COALESCE(payload,'{}'::jsonb),idempotency_key,available_at)
  ON CONFLICT ("idempotencyKey") DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION signing_recipient_resolution_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='signed' AND OLD.status IS DISTINCT FROM 'signed' THEN
    PERFORM signing_enqueue_job(NEW."tenantId",NEW."requestId",NEW.id,'advance_after_signature',
      jsonb_build_object('recipientId',NEW.id),'advance-after-signature:'||NEW."requestId"||':'||NEW.id,now());
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "SignatureRecipient_resolution_outbox" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_resolution_outbox" AFTER UPDATE OF status ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_recipient_resolution_outbox();

CREATE OR REPLACE FUNCTION signing_approval_resolution_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('approved','rejected') AND OLD.status='pending' THEN
    PERFORM signing_enqueue_job(NEW."tenantId",NEW."requestId",NULL,'advance_after_signature',
      jsonb_build_object('approvalStepId',NEW.id),'advance-after-approval:'||NEW.id,now());
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "ApprovalStep_resolution_outbox" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_resolution_outbox" AFTER UPDATE OF status ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_approval_resolution_outbox();

CREATE OR REPLACE FUNCTION signing_request_state_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE recipient record;
BEGIN
  IF NEW.status='signatures_complete' AND OLD.status IS DISTINCT FROM 'signatures_complete' THEN
    PERFORM signing_enqueue_job(NEW."tenantId",NEW.id,NULL,'advance_after_signature','{}'::jsonb,
      'complete-envelope:'||NEW.id,now());
  END IF;
  IF NEW.status IN ('sealed','distributing') AND OLD.status NOT IN ('sealed','distributing') THEN
    PERFORM signing_enqueue_job(NEW."tenantId",NEW.id,NULL,'post_complete','{}'::jsonb,
      'post-complete:'||NEW.id,now());
    PERFORM signing_enqueue_job(NEW."tenantId",NEW.id,NULL,'reconcile_envelope','{}'::jsonb,
      'reconcile-envelope:'||NEW.id||':v1',now());
    FOR recipient IN SELECT id FROM "SignatureRecipient" WHERE "requestId"=NEW.id AND email IS NOT NULL LOOP
      PERFORM signing_enqueue_job(NEW."tenantId",NEW.id,recipient.id,'deliver_completed','{}'::jsonb,
        'completed-delivery-job:'||NEW.id||':'||recipient.id,now());
    END LOOP;
    PERFORM signing_enqueue_job(NEW."tenantId",NEW.id,NULL,'finalize_completion','{}'::jsonb,
      'finalize-completion:'||NEW.id||':v1',now()+interval '30 seconds');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "SignatureRequest_state_outbox" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_state_outbox" AFTER UPDATE OF status ON "SignatureRequest"
FOR EACH ROW EXECUTE FUNCTION signing_request_state_outbox();
