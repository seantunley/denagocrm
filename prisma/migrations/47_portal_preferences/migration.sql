CREATE TABLE "PortalPreference" (
  "contactId" TEXT NOT NULL,
  "emailServiceUpdates" BOOLEAN NOT NULL DEFAULT true,
  "smsServiceUpdates" BOOLEAN NOT NULL DEFAULT true,
  "emailMarketing" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalPreference_pkey" PRIMARY KEY ("contactId")
);
ALTER TABLE "PortalPreference" ADD CONSTRAINT "PortalPreference_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
