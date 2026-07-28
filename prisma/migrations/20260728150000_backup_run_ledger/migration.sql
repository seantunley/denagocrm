-- Ledger of backup runs, for the platform console's health view.
--
-- Until now the only trace of a backup was the newest blob in storage plus a
-- single BACKUP_LAST_RESULT setting holding the last outcome. Neither keeps
-- HISTORY, and neither distinguishes "ran and failed" from "never started" — a
-- crashed run looked exactly like a quiet one.
--
-- A row is inserted when a run STARTS (status 'running') and updated when it
-- finishes, so a row still 'running' long after startedAt is itself the evidence
-- that a run died. Silence can never carry that signal.
--
-- tenantId is nullable and always NULL for now: backups are platform-wide, not
-- per-tenant. The column exists so per-tenant backups can populate it later
-- without a schema change.

CREATE TABLE IF NOT EXISTS "BackupRun" (
  "id"         TEXT         NOT NULL,
  "tenantId"   TEXT,
  "status"     TEXT         NOT NULL DEFAULT 'running',
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "sizeBytes"  INTEGER,
  "blobPath"   TEXT,
  "error"      TEXT,
  "degraded"   BOOLEAN      NOT NULL DEFAULT false,

  CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BackupRun_startedAt_idx"
  ON "BackupRun"("startedAt");

CREATE INDEX IF NOT EXISTS "BackupRun_status_startedAt_idx"
  ON "BackupRun"("status", "startedAt");

CREATE INDEX IF NOT EXISTS "BackupRun_tenantId_startedAt_idx"
  ON "BackupRun"("tenantId", "startedAt");
