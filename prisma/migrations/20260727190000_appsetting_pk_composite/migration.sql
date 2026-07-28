-- AppSetting: replace global `key` PK with a surrogate `id` PK + composite
-- unique on (tenantId, key). This allows the same key to exist per-tenant
-- while still preventing duplicate keys within a single tenant.
--
-- Migration is replay-safe: each step guards against re-execution.
--   1. ADD COLUMN id (nullable, with server-side UUID default)
--   2. Backfill any rows that might have id=NULL (shouldn't happen, but idempotent)
--   3. SET NOT NULL
--   4. DROP old PK on key
--   5. ADD new PK on id
--   6. CREATE composite unique index on (tenantId, key)
--
-- gen_random_uuid() is built-in from PG 13+; no extension needed.

ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "id" TEXT DEFAULT gen_random_uuid()::text;
UPDATE "AppSetting" SET "id" = gen_random_uuid()::text WHERE "id" IS NULL;
ALTER TABLE "AppSetting" ALTER COLUMN "id" SET NOT NULL;

-- Drop the implicit primary key that was on `key` (Prisma names it `<table>_pkey`)
DO $$ BEGIN
  ALTER TABLE "AppSetting" DROP CONSTRAINT "AppSetting_pkey";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "AppSetting_tenantId_key_key"
  ON "AppSetting" ("tenantId", "key");
