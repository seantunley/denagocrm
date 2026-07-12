-- Document Studio: free-form templates, immutable versions, instances, clauses
CREATE TABLE "CustomDocTemplate" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT,
    "draftJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3),
    CONSTRAINT "CustomDocTemplate_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CustomDocVersion" (
    "id" TEXT NOT NULL, "version" INTEGER NOT NULL, "contentJson" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "publishedBy" TEXT,
    "templateId" TEXT NOT NULL,
    CONSTRAINT "CustomDocVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomDocVersion_templateId_version_key" ON "CustomDocVersion"("templateId", "version");
ALTER TABLE "CustomDocVersion" ADD CONSTRAINT "CustomDocVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CustomDocTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "DocInstance" (
    "id" TEXT NOT NULL, "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft',
    "contentJson" JSONB NOT NULL, "snapshotJson" JSONB,
    "contactId" TEXT, "leadId" TEXT, "quoteId" TEXT, "pdfDocId" TEXT,
    "createdById" TEXT, "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3),
    "templateVersionId" TEXT, "templateId" TEXT,
    CONSTRAINT "DocInstance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocInstance_status_updatedAt_idx" ON "DocInstance"("status", "updatedAt");
ALTER TABLE "DocInstance" ADD CONSTRAINT "DocInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CustomDocTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "ReusableBlock" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "category" TEXT, "contentJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3),
    CONSTRAINT "ReusableBlock_pkey" PRIMARY KEY ("id")
);
