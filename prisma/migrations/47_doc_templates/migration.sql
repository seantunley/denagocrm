-- Named document templates (many per type, one default per type)
CREATE TABLE "DocTemplateRecord" (
    "id" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "DocTemplateRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocTemplateRecord_docType_isDefault_idx" ON "DocTemplateRecord"("docType", "isDefault");
