-- Every committed human decision gets a durable continuation job. Inline callers
-- still run for responsiveness; the outbox is the crash-recovery authority.
SET app.bypass_rls = 'on';

CREATE OR REPLACE FUNCTION signing_enqueue_recipient_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'signed' THEN
    INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
    VALUES (
      'sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."requestId",
      'advance_signature', 'advance:' || NEW."requestId" || ':' || NEW."id",
      jsonb_build_object('recipientId', NEW."id")
    ) ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;
  ELSIF OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" = 'declined' THEN
    INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
    VALUES (
      'sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."requestId",
      'decline_notify', 'decline:' || NEW."requestId" || ':' || NEW."id",
      jsonb_build_object('recipientId', NEW."id")
    ) ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureRecipient_enqueue_transition" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_enqueue_transition"
AFTER UPDATE OF "status" ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_enqueue_recipient_transition();

CREATE OR REPLACE FUNCTION signing_enqueue_approval_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" AND NEW."status" IN ('approved','rejected') THEN
    INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
    VALUES (
      'sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."requestId",
      'advance_approval', 'approval:' || NEW."requestId" || ':' || NEW."id",
      jsonb_build_object('approvalStepId', NEW."id", 'decision', NEW."status")
    ) ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "ApprovalStep_enqueue_transition" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_enqueue_transition"
AFTER UPDATE OF "status" ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_enqueue_approval_transition();

RESET app.bypass_rls;
