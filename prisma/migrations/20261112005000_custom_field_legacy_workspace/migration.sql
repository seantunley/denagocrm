-- Reentrant (the migration runner has no transaction). Review of #1064.
-- Custom-field reads now always name the workspace, so a definition or value
-- with NO workspace would vanish from the CRM. The July backfill
-- (20260722149000) stamped every row of its day, but definitions and values
-- were still created without one afterwards. Production held none on
-- 2026-11-12 (checked read-only); this keeps any other database whole.
--
-- Runs BEFORE 20261112010000 makes keys unique per workspace: under the old
-- global ("entity","key") rule a workspace-less definition can't share a key
-- with the founding workspace's, so stamping it there can't collide.
--
-- Both tables FORCE row-level security: without lifting it for this session a
-- role lacking BYPASSRLS would update nothing and still be recorded as applied.
SET app.bypass_rls = 'on';
-- 1. A definition with no workspace belongs to the founding workspace — the same
--    rule as the July backfill (the only workspace that existed before tenancy).
UPDATE "CustomFieldDef" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
-- 2. A value takes its definition's workspace — the value stays exactly as it was.
UPDATE "CustomFieldValue" v
   SET "tenantId" = d."tenantId"
  FROM "CustomFieldDef" d
 WHERE v."defId" = d.id
   AND v."tenantId" IS NULL
   AND d."tenantId" IS NOT NULL;
