-- Finance became its own module (Sean, 2026-11-16: "Financing must be its own module that can be turned off").
-- It is built on Suppliers (the finance house is a supplier), so each existing workspace that has Suppliers is granted
-- it — the finance work it ships with stays where it is. The platform owner revokes it per workspace, and a workspace
-- switches it off in Settings → Modules. Additive; re-runnable (a workspace that already lists it is left alone).
UPDATE "Tenant"
SET "modules" = "modules" || ',finance'
WHERE 'suppliers' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ','))
  AND NOT ('finance' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ',')));
