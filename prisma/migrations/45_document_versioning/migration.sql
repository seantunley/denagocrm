-- Repository versioning: link a replaced file to its newer version
ALTER TABLE "Document" ADD COLUMN "replacedById" TEXT;
