-- Versioning for the document builder. Additive: new columns default-safe, new table.
ALTER TABLE "DocBuilderTemplate" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "DocBuilderTemplate" ADD COLUMN "publishedVersion" INTEGER;

CREATE TABLE "DocBuilderVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "label" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,
    "templateId" TEXT NOT NULL,
    CONSTRAINT "DocBuilderVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocBuilderVersion_templateId_version_key" ON "DocBuilderVersion"("templateId", "version");
CREATE INDEX "DocBuilderVersion_templateId_version_idx" ON "DocBuilderVersion"("templateId", "version");
ALTER TABLE "DocBuilderVersion" ADD CONSTRAINT "DocBuilderVersion_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "DocBuilderTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
