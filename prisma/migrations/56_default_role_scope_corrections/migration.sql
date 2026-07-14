-- The original governance migration predated cross-module record scopes and
-- granted Sales Manager organisation-wide lead visibility. Platform-wide RBAC
-- now gives that role its managed/member teams by default. CRM Administrator
-- remains the built-in organisation-wide role; custom roles can opt into any
-- view_all permission explicitly.

DELETE FROM "RolePermission"
WHERE "roleId" = 'role_sales_manager'
  AND "permissionKey" IN (
    'leads.view_all',
    'contacts.view_all',
    'quotes.view_all',
    'vehicles.view_all',
    'jobcards.view_all',
    'documents.view_all',
    'cases.view_all',
    'reports.view_all'
  );

INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_sales_manager', 'leads.view_owned'),
  ('role_sales_manager', 'contacts.view_owned'),
  ('role_sales_manager', 'quotes.view_owned'),
  ('role_sales_manager', 'vehicles.view_owned'),
  ('role_sales_manager', 'jobcards.view_owned'),
  ('role_sales_manager', 'documents.view_owned'),
  ('role_sales_manager', 'cases.view_owned'),
  ('role_sales_manager', 'reports.view_team')
ON CONFLICT DO NOTHING;
