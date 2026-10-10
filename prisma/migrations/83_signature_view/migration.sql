-- Engagement analytics for signing sessions. Not part of the evidence hash chain.
CREATE TABLE "SignatureView" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "requestId" TEXT NOT NULL,
    "recipientId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "maxPage" INTEGER NOT NULL DEFAULT 1,
    "sections" JSONB,
    "channel" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "SignatureView_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SignatureView_requestId_idx" ON "SignatureView"("requestId");
CREATE INDEX "SignatureView_tenantId_idx" ON "SignatureView"("tenantId");

ALTER TABLE "SignatureView" ADD CONSTRAINT "SignatureView_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
