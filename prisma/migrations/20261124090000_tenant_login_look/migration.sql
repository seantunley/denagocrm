-- Each workspace's sign-in screen: its wording and what the right-hand side shows (lib/loginLook.ts). Additive and
-- nullable: null is today's standard page, so no workspace's sign-in changes until someone edits it.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "loginJson" JSONB;
