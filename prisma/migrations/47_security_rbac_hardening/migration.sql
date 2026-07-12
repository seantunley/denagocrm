-- Persistent authentication throttling and immediate session revocation.

ALTER TABLE "User"
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SecurityRateLimit" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityRateLimit_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "SecurityRateLimit_count_check" CHECK ("count" >= 0)
);

CREATE INDEX "SecurityRateLimit_blockedUntil_idx"
  ON "SecurityRateLimit"("blockedUntil")
  WHERE "blockedUntil" IS NOT NULL;

-- Remove expired limiter rows without requiring a scheduled cleanup before rollout.
DELETE FROM "SecurityRateLimit"
WHERE "updatedAt" < CURRENT_TIMESTAMP - INTERVAL '30 days';
