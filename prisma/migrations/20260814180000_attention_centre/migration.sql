-- The Attention Centre: dismissal state on Lead, and three indexes.
--
-- ADDITIVE AND INERT. Both columns default to NULL, which `isDismissed` reads as
-- "still listed" — the behaviour every existing row already has. The indexes
-- change no result, only how fast it is reached.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode and every statement carries its own guard.
--
-- ── WHY DISMISSAL CARRIES A REASON ──────────────────────────────────────────
--
-- This is the one screen whose job is to make sure nothing is forgotten, so the
-- only way off it has to be accountable. A one-click dismiss is a button that
-- makes work disappear, and the first time somebody asks "why did nobody chase
-- this deal", the honest answer would be "someone clicked something".
--
-- The reason is stored on the ROW as well as in the audit log, because the row is
-- what the restore view reads: "Dismissed — customer asked us to call in March"
-- is the sentence somebody needs while deciding whether to bring it back, and
-- making that view join the audit log for one string would be a query per row.
--
-- Nullable rather than NOT NULL DEFAULT '': "never dismissed" and "dismissed with
-- an empty reason" must not be the same state, and the second one is impossible
-- by construction — the action refuses a reason shorter than MIN_DISMISS_REASON.

-- TWO WAYS OFF THE LIST, because they are different decisions:
--
--   SNOOZE   nothing is wrong — come back on a date. The commonest case by far:
--            "in Italy at the moment, back on the 19th".
--   DISMISS  this does not belong on the list at all.
--
-- Both carry a reason. Neither is a one-click exit, and an elapsed snooze is
-- simply not snoozed — the loader compares against `now`, so a deal reappears on
-- its own and nothing has to sweep the column.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "attentionSnoozedUntil" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "attentionSnoozeReason" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "attentionDismissedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "attentionDismissReason" TEXT;

-- ── The three indexes the loader's queries need ─────────────────────────────
--
-- Each one matches a signal family's WHERE clause, leading with "tenantId"
-- because every query is tenant-scoped by the guarded client before anything
-- else narrows it. Precedent for the shape: survey-operations.prisma already
-- carries @@index([tenantId, status, dueAt]) for a work queue, which is exactly
-- what this is.
--
-- CONCURRENTLY is deliberately NOT used. It cannot run inside a transaction
-- block, and while this runner opens none, a CONCURRENTLY build that fails
-- leaves an INVALID index behind that a re-run will not repair — trading a brief
-- lock on a table of this size for a state needing manual cleanup. IF NOT EXISTS
-- gives the reentrancy; the lock is milliseconds at these row counts.

-- overdue_task: planned activities past their due date.
CREATE INDEX IF NOT EXISTS "Activity_tenant_status_due_idx"
  ON "Activity" ("tenantId", "status", "dueDate");

-- quote_expiring: sent quotes inside the validity window.
CREATE INDEX IF NOT EXISTS "Quote_tenant_status_validuntil_idx"
  ON "Quote" ("tenantId", "status", "validUntil");

-- stage_age: open leads ordered by how long they have sat where they are.
CREATE INDEX IF NOT EXISTS "Lead_tenant_status_stageentered_idx"
  ON "Lead" ("tenantId", "status", "stageEnteredAt");

-- Conversation needs nothing: @@index([lastDirection, lastMessageAt]) and
-- @@index([leadId]) already cover unanswered_inbound.
