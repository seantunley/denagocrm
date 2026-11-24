-- Each workspace's own square app icon: the browser tab, the installed app and its notifications (lib/appIcon.ts).
-- Additive and nullable: null falls back to a square logo, else a letter tile — never another workspace's mark.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "brandIconRef" TEXT;
