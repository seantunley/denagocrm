-- Reentrant (the migration runner has no transaction). Review of #1064.
-- A custom field's key is unique WITHIN A WORKSPACE, not across all of them:
-- with ("entity","key") unique globally, a second workspace adding a field whose
-- label another workspace had already used failed on save. No data changes —
-- the new index is created first, then the old, narrower-scoped one dropped.
CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_tenantId_entity_key_key" ON "CustomFieldDef"("tenantId", "entity", "key");
DROP INDEX IF EXISTS "CustomFieldDef_entity_key_key";
