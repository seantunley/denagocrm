-- Proof of delivery: driver, handover checklist, on-device signature
ALTER TABLE "Quote" ADD COLUMN "deliveredByName" TEXT;
ALTER TABLE "Quote" ADD COLUMN "deliveryChecklist" JSONB;
ALTER TABLE "Quote" ADD COLUMN "deliverySignatureRef" TEXT;
