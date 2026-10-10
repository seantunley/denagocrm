-- Permissions the app checks, which no role could be given.
--
-- Settings → Access lists what can be ticked from the "Permission" table, and a
-- role can only hold a key that exists there (RolePermission.permissionKey
-- references it). Seven keys were added to src/lib/permissions.ts and checked by
-- the app, but never inserted here — so no role could hold them, and the only
-- people who passed those checks were owners, who skip them.
--
-- The one that was noticed: nobody but an owner could open Signatures, sign a
-- document in person, or remind a signer.
--
-- Data only, additive and re-runnable. Role and RolePermission FORCE row-level
-- security, so the grant below reads and writes them with the session escape —
-- without it, under a migrating role that does not bypass RLS, the SELECT
-- matches no rows, nothing is granted, and the migration is still recorded as
-- applied.

SET app.bypass_rls = 'on';

INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('signing.view', 'View signature requests on accessible quotes, job cards and documents', 'Documents'),
  ('signing.manage', 'Send, remind, withdraw and sign in person on accessible quotes, job cards and documents', 'Documents'),
  ('docbuilder.view', 'View document layouts and their history', 'Documents'),
  ('docbuilder.manage', 'Create and edit document layouts and the content library', 'Documents'),
  ('cases.create', 'Create customer cases', 'Customer service'),
  ('cases.assign', 'Assign customer cases to people', 'Customer service'),
  ('leads.override_stage_rules', 'Move a lead past a stage rule that blocks it', 'CRM')
ON CONFLICT ("key") DO UPDATE SET
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category";

-- Signatures follows a door people already have. Sending a quote for signature
-- takes quotes.change_status and a job card takes jobcards.manage
-- (src/app/actions/recordSigning.ts), so every role holding either could already
-- START a signature from the record — and then could not open what it had
-- started. Those roles, in every workspace, get both keys. What each person sees
-- is still limited to the records they can open (src/lib/signing/access.ts).
--
-- The tenant is the ROLE's own, which is what RolePermission.tenantId
-- denormalises.
--
-- The other five are made grantable and given to nobody: who should hold them is
-- the owner's decision, in Settings → Access.
INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
SELECT r."id", granted."permissionKey", r."tenantId"
FROM "Role" r
CROSS JOIN (VALUES ('signing.view'), ('signing.manage')) AS granted("permissionKey")
WHERE EXISTS (
  SELECT 1 FROM "RolePermission" held
  WHERE held."roleId" = r."id"
    AND held."permissionKey" IN ('quotes.change_status', 'jobcards.manage')
)
ON CONFLICT DO NOTHING;

RESET app.bypass_rls;
