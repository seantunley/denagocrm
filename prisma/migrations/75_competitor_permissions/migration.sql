-- Competitor intelligence RBAC: seed the permission-catalogue rows so the keys
-- exist in the "Permission" table (RolePermission.permissionKey references it) and
-- can be granted to non-owner roles. Owners keep their application-level bypass.
-- Additive + idempotent; role grants are guarded so a missing role can't FK-fail.

INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('competitors.view', 'View competitor intelligence', 'Marketing'),
  ('competitors.manage', 'Add and edit competitors and their monitored sources', 'Marketing'),
  ('competitors.review', 'Review and dismiss detected competitor changes', 'Marketing'),
  ('competitors.research', 'Run AI discovery and deep-research on competitors', 'Marketing')
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category";

-- CRM administrators receive every competitor permission (matches migration 55).
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT 'role_crm_admin', "key" FROM "Permission"
WHERE "key" LIKE 'competitors.%'
  AND EXISTS (SELECT 1 FROM "Role" WHERE "id" = 'role_crm_admin')
ON CONFLICT DO NOTHING;

-- Sales managers can view and review competitive intel.
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT 'role_sales_manager', v.k
FROM (VALUES ('competitors.view'), ('competitors.review')) AS v(k)
WHERE EXISTS (SELECT 1 FROM "Role" WHERE "id" = 'role_sales_manager')
ON CONFLICT DO NOTHING;
