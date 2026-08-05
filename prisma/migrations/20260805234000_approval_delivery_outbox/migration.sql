-- An approval row is the durable intent to contact an approver. Its notification
-- must be retryable independently of the workflow interpreter that created it.
SET app.bypass_rls = 'on';

CREATE OR REPLACE FUNCTION signing_enqueue_approval_delivery() RETURNS trigger AS $$
BEGIN
  INSERT INTO "SigningJob" (
    "id","tenantId","requestId","jobType","idempotencyKey","payload","status"
  ) VALUES (
    'sj_' || replace(gen_random_uuid()::text, '-', ''),
    NEW."tenantId",
    NEW."requestId",
    'approval_notify',
    'approval-notify:' || NEW."requestId" || ':' || NEW."id",
    jsonb_build_object('approvalStepId', NEW."id"),
    'transition'
  ) ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ApprovalStep_enqueue_delivery" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_enqueue_delivery"
AFTER INSERT ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_enqueue_approval_delivery();

-- Backfill only still-pending approvals that have no accepted-delivery marker.
INSERT INTO "SigningJob" (
  "id","tenantId","requestId","jobType","idempotencyKey","payload","status"
)
SELECT
  'sj_' || replace(gen_random_uuid()::text, '-', ''),
  s."tenantId",
  s."requestId",
  'approval_notify',
  'approval-notify:' || s."requestId" || ':' || s."id",
  jsonb_build_object('approvalStepId', s."id"),
  'transition'
FROM "ApprovalStep" s
JOIN "SignatureRequest" r
  ON r."id" = s."requestId" AND r."tenantId" = s."tenantId"
WHERE s."status" = 'pending'
  AND r."status" NOT IN ('completed','declined','expired','voided','rejected')
  AND NOT EXISTS (
    SELECT 1 FROM "SignatureEvent" e
    WHERE e."tenantId" = s."tenantId"
      AND e."requestId" = s."requestId"
      AND e."type" = 'approval_sent'
      AND e."metadata"->>'stepId' = s."id"
  )
ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;

RESET app.bypass_rls;
