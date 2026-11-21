-- Warranty became its own module (Sean, 2026-11-21: "Warranty must be a completely seperate module and everything
-- warranty related needs to be removed from the CRM, should the warranty module be off"). It was part of Automotive, so
-- every workspace that has Automotive is granted it: its claims, recalls and cover stay where its people use them. The
-- platform owner revokes it per workspace, and a workspace switches it off in Settings → Modules (off: hidden, kept).
-- Additive; re-runnable (a workspace that already lists it is left alone).
UPDATE "Tenant"
SET "modules" = "modules" || ',warranty'
WHERE 'automotive' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ','))
  AND NOT ('warranty' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ',')));
