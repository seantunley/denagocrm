ALTER TABLE "PortalPreference"
  ADD COLUMN "emailServiceUpdates" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "smsServiceUpdates" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "emailMarketing" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "PortalProfileChangeRequest"
  ADD COLUMN "reviewNote" TEXT;
