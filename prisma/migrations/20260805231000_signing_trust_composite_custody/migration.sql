-- Cross-tenant references must be impossible even for raw/system writes.
SET app.bypass_rls = 'on';

CREATE UNIQUE INDEX IF NOT EXISTS "LegalArtifact_tenantId_id_key"
  ON "LegalArtifact"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Document_tenantId_id_key"
  ON "Document"("tenantId", "id");

DO $$ BEGIN
  ALTER TABLE "LegalArtifact" ADD CONSTRAINT "LegalArtifact_tenantId_documentId_fkey"
    FOREIGN KEY ("tenantId", "documentId") REFERENCES "Document"("tenantId", "id")
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "LegalArtifactValidation" ADD CONSTRAINT "LegalArtifactValidation_tenantId_artifactId_fkey"
    FOREIGN KEY ("tenantId", "artifactId") REFERENCES "LegalArtifact"("tenantId", "id")
    ON DELETE RESTRICT NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "LegalArtifact" VALIDATE CONSTRAINT "LegalArtifact_tenantId_documentId_fkey";
ALTER TABLE "LegalArtifactValidation" VALIDATE CONSTRAINT "LegalArtifactValidation_tenantId_artifactId_fkey";

RESET app.bypass_rls;
