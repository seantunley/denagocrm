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
-- Deliberately has NO tenantId column, and BackupRun is listed in GLOBAL_MODELS.
-- Backups are platform-wide (exportAllData dumps the whole database), so every row
-- would carry a null tenant. A nullable tenantId would be worse than none: the
-- tenant guard would classify this model as tenant-scoped and the enforcement
-- preflight would hard-fail on every null row. Add the column, and drop the
-- GLOBAL_MODELS entry, in the same change that makes backups per-tenant.

CREATE TABLE IF NOT EXISTS "BackupRun" (
  "id"         TEXT         NOT NULL,
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

