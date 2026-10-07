-- Email open tracking (Sean, 2026-10-07): each tracked email carries a token in
-- its pixel; the first load stamps "seenAt" (the customer opened it) and every
-- load counts. Additive and re-runnable; no existing row changes.

ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "openToken" TEXT;
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "openCount" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "Communication_openToken_key" ON "Communication"("openToken");
