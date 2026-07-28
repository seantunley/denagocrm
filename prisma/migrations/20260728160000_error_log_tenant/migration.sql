-- Attribute system errors to a tenant.
--
-- ErrorLog had no tenant column, so with more than one tenant the system log is a
-- single undifferentiated firehose: there is no way to ask "which tenant is
-- broken?", which makes it useless as a health signal.
--
-- NULLABLE, and ErrorLog REMAINS in GLOBAL_MODELS, deliberately. Errors happen on
-- paths that have no tenant — pre-auth failures, webhooks, cron sweeps, and tenant
-- resolution itself failing. Were this model tenant-scoped, an unscoped write
-- would fail closed under enforcement and the error log would vanish exactly when
-- things are breaking. Logging must never throw, so tenant attribution is a bonus,
-- never a precondition.
--
-- Existing rows stay NULL: which tenant they belonged to is not recoverable, and
-- guessing would be worse than admitting it. They surface as "unattributed".

ALTER TABLE "ErrorLog"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Supports both "this tenant's recent errors" and the per-tenant alert throttle.
CREATE INDEX IF NOT EXISTS "ErrorLog_tenantId_createdAt_idx"
  ON "ErrorLog"("tenantId", "createdAt");
