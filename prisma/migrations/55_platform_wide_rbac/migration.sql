-- Extend granular RBAC across the application.
-- Owners retain the explicit application-level bypass. All other guarded access
-- is granted through RolePermission rows seeded below.

INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('contacts.view_all', 'View every contact', 'CRM'),
  ('contacts.view_owned', 'View contacts owned, created or linked to accessible work', 'CRM'),
  ('contacts.create', 'Create contacts', 'CRM'),
  ('contacts.edit', 'Edit accessible contacts', 'CRM'),
  ('contacts.delete', 'Move accessible contacts to Trash', 'CRM'),
  ('contacts.merge', 'Merge duplicate contacts', 'CRM'),
  ('quotes.view_all', 'View every quote', 'Sales'),
  ('quotes.view_owned', 'View quotes created by the user or linked to accessible records', 'Sales'),
  ('quotes.create', 'Create quotes', 'Sales'),
  ('quotes.edit', 'Edit and revise accessible quotes', 'Sales'),
  ('quotes.change_status', 'Send, accept, decline or reopen accessible quotes', 'Sales'),
  ('quotes.delete', 'Move accessible quotes to Trash', 'Sales'),
  ('documents.view_all', 'View every document and repository file', 'Documents'),
  ('documents.view_owned', 'View documents linked to accessible records', 'Documents'),
  ('documents.upload', 'Upload documents to accessible records', 'Documents'),
  ('documents.manage', 'Rename, re-file, replace and delete documents', 'Documents'),
  ('document_templates.manage', 'Create and manage generated-document templates', 'Documents'),
  ('cases.view_all', 'View every customer case', 'Customer service'),
  ('cases.view_owned', 'View customer cases linked to accessible records', 'Customer service'),
  ('cases.reply', 'Reply to accessible customer cases', 'Customer service'),
  ('cases.manage', 'Change accessible case status and administration fields', 'Customer service'),
  ('campaigns.view', 'View campaigns and audiences', 'Marketing'),
  ('surveys.view', 'View surveys and responses', 'Marketing'),
  ('surveys.manage', 'Create, send and manage surveys', 'Marketing'),
  ('vehicles.view_all', 'View every vehicle', 'Workshop'),
  ('vehicles.view_owned', 'View vehicles linked to accessible customers or fleets', 'Workshop'),
  ('vehicles.manage', 'Create, edit and delete accessible vehicles', 'Workshop'),
  ('jobcards.view_all', 'View every job card', 'Workshop'),
  ('jobcards.view_owned', 'View assigned job cards and job cards linked to accessible records', 'Workshop'),
  ('jobcards.manage', 'Create, update and complete accessible job cards', 'Workshop'),
  ('parts.view', 'View parts and stock levels', 'Workshop'),
  ('parts.manage', 'Create, edit and adjust parts stock', 'Workshop'),
  ('warranty.view', 'View warranty claims, recalls and battery checks', 'Workshop'),
  ('warranty.manage', 'Create and manage warranty claims, recalls and battery checks', 'Workshop'),
  ('fleets.view', 'View fleet accounts', 'CRM'),
  ('fleets.manage', 'Create and manage fleet accounts', 'CRM'),
  ('stock.view', 'View vehicle stock and purchase orders', 'Stock'),
  ('stock.manage', 'Manage vehicle stock, reservations and purchase orders', 'Stock'),
  ('library.view', 'View the company document library', 'Documents'),
  ('library.manage', 'Upload and version company library documents', 'Documents'),
  ('activities.view', 'View activities and calendars', 'CRM'),
  ('activities.manage', 'Create, assign and complete activities', 'CRM'),
  ('inbox.view', 'View social inbox conversations', 'Communications'),
  ('inbox.reply', 'Reply through connected social channels', 'Communications'),
  ('deliveries.view', 'View delivery and fulfilment records', 'Sales'),
  ('deliveries.manage', 'Manage delivery milestones, files and handover', 'Sales'),
  ('referrals.view', 'View referral records', 'CRM'),
  ('referrals.manage', 'Create, earn and redeem referrals', 'CRM'),
  ('reports.view_all', 'View organisation-wide reports', 'Reporting'),
  ('reports.view_team', 'View reports restricted to owned and team records', 'Reporting'),
  ('portal_access.manage', 'Manage delegated customer-portal access and profile approvals', 'Administration'),
  ('privacy.export', 'Export personal data and privacy records', 'Governance')
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category";

-- CRM administrators receive every permission, including newly added keys.
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT 'role_crm_admin', "key" FROM "Permission"
ON CONFLICT DO NOTHING;

-- Sales managers: complete sales/customer operations and organisation reporting.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_sales_manager', 'contacts.view_all'), ('role_sales_manager', 'contacts.create'),
  ('role_sales_manager', 'contacts.edit'), ('role_sales_manager', 'contacts.delete'),
  ('role_sales_manager', 'contacts.merge'),
  ('role_sales_manager', 'quotes.view_all'), ('role_sales_manager', 'quotes.create'),
  ('role_sales_manager', 'quotes.edit'), ('role_sales_manager', 'quotes.change_status'),
  ('role_sales_manager', 'quotes.delete'),
  ('role_sales_manager', 'documents.view_all'), ('role_sales_manager', 'documents.upload'),
  ('role_sales_manager', 'documents.manage'),
  ('role_sales_manager', 'cases.view_all'), ('role_sales_manager', 'cases.reply'),
  ('role_sales_manager', 'cases.manage'),
  ('role_sales_manager', 'campaigns.view'), ('role_sales_manager', 'campaigns.manage'),
  ('role_sales_manager', 'surveys.view'), ('role_sales_manager', 'surveys.manage'),
  ('role_sales_manager', 'fleets.view'), ('role_sales_manager', 'fleets.manage'),
  ('role_sales_manager', 'stock.view'), ('role_sales_manager', 'stock.manage'),
  ('role_sales_manager', 'library.view'), ('role_sales_manager', 'library.manage'),
  ('role_sales_manager', 'activities.view'), ('role_sales_manager', 'activities.manage'),
  ('role_sales_manager', 'inbox.view'), ('role_sales_manager', 'inbox.reply'),
  ('role_sales_manager', 'deliveries.view'), ('role_sales_manager', 'deliveries.manage'),
  ('role_sales_manager', 'referrals.view'), ('role_sales_manager', 'referrals.manage'),
  ('role_sales_manager', 'reports.view_all'), ('role_sales_manager', 'privacy.export')
ON CONFLICT DO NOTHING;

-- Sales representatives: only owned/team customer and sales records.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_sales_rep', 'contacts.view_owned'), ('role_sales_rep', 'contacts.create'),
  ('role_sales_rep', 'contacts.edit'),
  ('role_sales_rep', 'quotes.view_owned'), ('role_sales_rep', 'quotes.create'),
  ('role_sales_rep', 'quotes.edit'), ('role_sales_rep', 'quotes.change_status'),
  ('role_sales_rep', 'documents.view_owned'), ('role_sales_rep', 'documents.upload'),
  ('role_sales_rep', 'cases.view_owned'), ('role_sales_rep', 'cases.reply'),
  ('role_sales_rep', 'campaigns.view'), ('role_sales_rep', 'surveys.view'),
  ('role_sales_rep', 'fleets.view'), ('role_sales_rep', 'stock.view'),
  ('role_sales_rep', 'library.view'),
  ('role_sales_rep', 'activities.view'), ('role_sales_rep', 'activities.manage'),
  ('role_sales_rep', 'inbox.view'), ('role_sales_rep', 'inbox.reply'),
  ('role_sales_rep', 'deliveries.view'), ('role_sales_rep', 'deliveries.manage'),
  ('role_sales_rep', 'referrals.view'), ('role_sales_rep', 'referrals.manage'),
  ('role_sales_rep', 'reports.view_team')
ON CONFLICT DO NOTHING;

-- Marketing users need broad audience visibility but no sales-record mutation.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_marketing', 'contacts.view_all'),
  ('role_marketing', 'campaigns.view'), ('role_marketing', 'campaigns.manage'),
  ('role_marketing', 'surveys.view'), ('role_marketing', 'surveys.manage'),
  ('role_marketing', 'library.view'),
  ('role_marketing', 'inbox.view'), ('role_marketing', 'inbox.reply'),
  ('role_marketing', 'reports.view_all')
ON CONFLICT DO NOTHING;

-- Workshop managers can operate all after-sales records and related customers/files.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_workshop_manager', 'contacts.view_all'), ('role_workshop_manager', 'contacts.create'),
  ('role_workshop_manager', 'contacts.edit'),
  ('role_workshop_manager', 'documents.view_all'), ('role_workshop_manager', 'documents.upload'),
  ('role_workshop_manager', 'documents.manage'),
  ('role_workshop_manager', 'cases.view_all'), ('role_workshop_manager', 'cases.reply'),
  ('role_workshop_manager', 'cases.manage'),
  ('role_workshop_manager', 'vehicles.view_all'), ('role_workshop_manager', 'vehicles.manage'),
  ('role_workshop_manager', 'jobcards.view_all'), ('role_workshop_manager', 'jobcards.manage'),
  ('role_workshop_manager', 'parts.view'), ('role_workshop_manager', 'parts.manage'),
  ('role_workshop_manager', 'warranty.view'), ('role_workshop_manager', 'warranty.manage'),
  ('role_workshop_manager', 'fleets.view'), ('role_workshop_manager', 'fleets.manage'),
  ('role_workshop_manager', 'library.view'), ('role_workshop_manager', 'library.manage'),
  ('role_workshop_manager', 'activities.view'), ('role_workshop_manager', 'activities.manage'),
  ('role_workshop_manager', 'inbox.view'),
  ('role_workshop_manager', 'reports.view_all'), ('role_workshop_manager', 'privacy.export')
ON CONFLICT DO NOTHING;

-- Technicians see assigned/customer-linked workshop records only.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_technician', 'contacts.view_owned'),
  ('role_technician', 'documents.view_owned'), ('role_technician', 'documents.upload'),
  ('role_technician', 'cases.view_owned'), ('role_technician', 'cases.reply'),
  ('role_technician', 'vehicles.view_owned'), ('role_technician', 'vehicles.manage'),
  ('role_technician', 'jobcards.view_owned'), ('role_technician', 'jobcards.manage'),
  ('role_technician', 'parts.view'), ('role_technician', 'warranty.view'),
  ('role_technician', 'activities.view'), ('role_technician', 'activities.manage'),
  ('role_technician', 'reports.view_team')
ON CONFLICT DO NOTHING;

-- Auditors have broad read-only access and audit export.
INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_auditor', 'audit.export'),
  ('role_auditor', 'contacts.view_all'), ('role_auditor', 'quotes.view_all'),
  ('role_auditor', 'documents.view_all'), ('role_auditor', 'cases.view_all'),
  ('role_auditor', 'campaigns.view'), ('role_auditor', 'surveys.view'),
  ('role_auditor', 'vehicles.view_all'), ('role_auditor', 'jobcards.view_all'),
  ('role_auditor', 'parts.view'), ('role_auditor', 'warranty.view'),
  ('role_auditor', 'fleets.view'), ('role_auditor', 'stock.view'),
  ('role_auditor', 'library.view'), ('role_auditor', 'activities.view'),
  ('role_auditor', 'inbox.view'), ('role_auditor', 'deliveries.view'),
  ('role_auditor', 'referrals.view'), ('role_auditor', 'reports.view_all'),
  ('role_auditor', 'privacy.export')
ON CONFLICT DO NOTHING;
