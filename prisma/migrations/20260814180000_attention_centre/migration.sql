-- The Attention Centre: one nullable column and three indexes.
--
-- ADDITIVE AND INERT. The column defaults to NULL, which `isSnoozed` reads as
-- "not snoozed" — the behaviour every existing row already has. The indexes
-- change no result, only how fast it is reached. Nothing here is read until the
-- page exists, and nothing here changes what the board does today.
--
-- Reentrant by construction: this runner opens NO transaction, so a half-applied
-- migration is a real failure mode and every statement carries its own guard.
--
-- ── WHY A SNOOZE COLUMN AT ALL ──────────────────────────────────────────────
--
-- A signal you have already acknowledged must stop shouting, or the list stops
-- being read — and a list nobody reads is worse than no list, because it looks
-- like coverage. Precedent in this schema: CustomerCase.snoozedUntil.
--
-- Nullable rather than defaulted to a past timestamp, so "never snoozed" and
-- "snooze expired" are the same state and neither needs a backfill.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "attentionSnoozedUntil" TIMESTAMP(3);

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
