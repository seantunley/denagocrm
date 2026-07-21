-- At most one ApprovalStep per (requestId, nodeId). This makes decision-approval
-- materialisation idempotent: concurrent advanceWorkflow() calls (e.g. two
-- signing-start repairs) can no longer create two steps — two valid approve/
-- reject tokens and duplicate notifications — for the same workflow node.
--
-- Dedupe any pre-existing duplicates first (keep the earliest), so the unique
-- index can be created safely. ApprovalStep is a workshop/test-only table
-- (signing workflows are not in production), so this affects no live data.
DELETE FROM "ApprovalStep" a
USING "ApprovalStep" b
WHERE a."requestId" = b."requestId"
  AND a."nodeId" = b."nodeId"
  AND a."createdAt" > b."createdAt";

DELETE FROM "ApprovalStep" a
USING "ApprovalStep" b
WHERE a."requestId" = b."requestId"
  AND a."nodeId" = b."nodeId"
  AND a."createdAt" = b."createdAt"
  AND a."id" > b."id";

CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalStep_requestId_nodeId_key"
  ON "ApprovalStep" ("requestId", "nodeId");
