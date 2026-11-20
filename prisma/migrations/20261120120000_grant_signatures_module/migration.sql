-- Email signatures became its own module (Sean, 2026-11-20: "I think it needs its own module now" — a switchable pack
-- with its own page). Every existing workspace already has email signatures, so each is granted the pack: its signature
-- design, its page and its banners stay where its people use them. The platform owner revokes it per workspace, and a
-- workspace switches it off in Settings → Modules (off: emails keep the automatic signature, with no banners).
-- Additive; re-runnable (a workspace that already lists it is left alone). A brand-new workspace starts without it, as
-- with every pack, until it is granted.
UPDATE "Tenant"
SET "modules" = CASE WHEN coalesce("modules", '') = '' THEN 'signatures' ELSE "modules" || ',signatures' END
WHERE NOT ('signatures' = ANY (string_to_array(replace(coalesce("modules", ''), ' ', ''), ',')));
