-- Phase C · AppSetting.tenantId slice. ADDITIVE + BEHAVIOUR-PRESERVING (mirror of
-- the Phase B tenantId columns). AppSetting was deliberately excluded from Phase B
-- (decision 3): it becomes tenant-scoped, so it gets its own additive nullable
-- tenantId here. `key` stays the primary key (one row per key) — per-tenant values
-- for the SAME key (a composite/partial-unique change) are deferred to the
-- uniqueness batch. Nothing changes while enforcement is off: the db.ts guard is
-- dormant, so getSetting/putSetting still resolve by key exactly as before. Once
-- enforcement is on the guard scopes AppSetting by tenantId, and install-global
-- reads (META_APP_SECRET / verify token, backup/security config) use a system-scope
-- bypass — see PHASE-C-NO-USER-EDGES-DESIGN.md and the settings chokepoints.
--
-- No FK (matches Phase B + ChannelIdentity): the tenantId → Tenant FK arrives with
-- the composite-FK / RLS phase. tenantId stays NULLABLE for now (later NOT NULL,
-- after re-verifying zero NULL rows).
--
-- REPLAY-SAFE: additive column (IF NOT EXISTS), idempotent backfill (WHERE IS NULL),
-- index (IF NOT EXISTS). Safe to re-execute if the runner records it separately.

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill every existing setting to the founding Denago tenant (same target as
-- the Phase B backfills). Install-global keys are still read via a system-scope
-- bypass, so their owning tenant is immaterial to reads.
UPDATE "AppSetting" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;

CREATE INDEX IF NOT EXISTS "AppSetting_tenantId_idx" ON "AppSetting" ("tenantId");
