-- Suppliers became a module (2026-11-09). Every workspace already had suppliers (#1040) before there was a switch,
-- so each existing workspace is granted it — nothing it uses disappears. The platform owner revokes it per workspace
-- in the tenant platform; a workspace created from now on gets it only when granted. Additive; re-runnable (a
-- workspace that already lists it is left alone).
UPDATE "Tenant"
SET "modules" = CASE WHEN btrim(coalesce("modules", '')) = '' THEN 'suppliers' ELSE "modules" || ',suppliers' END
WHERE NOT ('suppliers' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ',')));
