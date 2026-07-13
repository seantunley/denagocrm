-- pdfme drag-drop document templates (additive; live print/signing pipeline untouched)
CREATE TABLE "PdfmeTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "schema" JSONB NOT NULL,
    "sample" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "PdfmeTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PdfmeTemplate_key_isDefault_idx" ON "PdfmeTemplate"("key", "isDefault");
