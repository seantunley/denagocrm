-- E-signing: unified signature-request hub. Additive.

CREATE TABLE "SignatureRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "ordering" TEXT NOT NULL DEFAULT 'parallel',
    "documentId" TEXT,
    "quoteId" TEXT,
    "jobCardId" TEXT,
    "contactId" TEXT,
    "templateId" TEXT,
    "snapshotJson" JSONB,
    "unsignedPdfRef" TEXT,
    "signedPdfRef" TEXT,
    "signedPdfHash" TEXT,
    "signedDocId" TEXT,
    "message" TEXT,
    "createdById" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "SignatureRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignatureRequest_status_updatedAt_idx" ON "SignatureRequest"("status", "updatedAt");
CREATE INDEX "SignatureRequest_quoteId_idx" ON "SignatureRequest"("quoteId");
CREATE INDEX "SignatureRequest_jobCardId_idx" ON "SignatureRequest"("jobCardId");
CREATE INDEX "SignatureRequest_contactId_idx" ON "SignatureRequest"("contactId");

CREATE TABLE "SignatureRecipient" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT NOT NULL DEFAULT 'signer',
    "order" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "signedAt" TIMESTAMP(3),
    "signedName" TEXT,
    "signatureRef" TEXT,
    "viewedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "signerIp" TEXT,
    "signerUserAgent" TEXT,
    "remindedAt" TIMESTAMP(3),
    CONSTRAINT "SignatureRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SignatureRecipient_token_key" ON "SignatureRecipient"("token");
CREATE INDEX "SignatureRecipient_requestId_order_idx" ON "SignatureRecipient"("requestId", "order");

CREATE TABLE "SignatureField" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "recipientId" TEXT,
    "kind" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT NOT NULL DEFAULT '',
    "value" TEXT,
    "filledAt" TIMESTAMP(3),
    CONSTRAINT "SignatureField_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignatureField_requestId_idx" ON "SignatureField"("requestId");

CREATE TABLE "SignatureEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "recipientId" TEXT,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "channel" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignatureEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignatureEvent_requestId_createdAt_idx" ON "SignatureEvent"("requestId", "createdAt");

ALTER TABLE "SignatureRecipient" ADD CONSTRAINT "SignatureRecipient_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "SignatureRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SignatureEvent" ADD CONSTRAINT "SignatureEvent_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
