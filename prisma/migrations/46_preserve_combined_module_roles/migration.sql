-- Preserve existing module access when a user previously had more than one module.
-- RBAC roles are additive, so CRM + Workshop users receive both sales and
-- technician roles, and existing CRM users retain campaign/journey access
-- through the dedicated Marketing role.

INSERT INTO "UserRole" ("userId", "roleId")
SELECT "id", 'role_technician'
FROM "User"
WHERE "role" <> 'owner'
  AND (',' || REPLACE("modules", ' ', '') || ',') LIKE '%,workshop,%'
ON CONFLICT DO NOTHING;

INSERT INTO "UserRole" ("userId", "roleId")
SELECT "id", 'role_marketing'
FROM "User"
WHERE "role" <> 'owner'
  AND (',' || REPLACE("modules", ' ', '') || ',') LIKE '%,crm,%'
ON CONFLICT DO NOTHING;
