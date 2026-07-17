-- Re-editable photo annotations for job-card check-in markup. Additive.
--   annotations:         JSON vector shapes + base image dimensions, so markup can be
--                        reopened and edited rather than baked-in once.
--   annotatedStoredName: flattened image (markup burned in) for display / print / PDF.
ALTER TABLE "Document" ADD COLUMN "annotations" JSONB;
ALTER TABLE "Document" ADD COLUMN "annotatedStoredName" TEXT;
