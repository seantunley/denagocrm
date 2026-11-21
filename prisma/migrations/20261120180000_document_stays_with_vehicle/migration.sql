-- A vehicle's document that passes to its next owner (warranty-transfer-brief.md, PR 2): the service book, the warranty
-- certificate. Additive, off for every existing document: a new owner never sees paperwork from before they took over
-- unless staff mark it (lib/portalAccess.ts).
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "staysWithVehicle" BOOLEAN NOT NULL DEFAULT false;
