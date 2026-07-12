-- Additive customer portal expansion.

CREATE TABLE "PortalAccessGrant" (
  "id" TEXT NOT NULL,
  "viewerContactId" TEXT NOT NULL,
  "grantedContactId" TEXT,
  "fleetId" TEXT,
  "role" TEXT NOT NULL DEFAULT 'viewer',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT,
  CONSTRAINT "PortalAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PortalAccessGrant_target_check" CHECK (
    ("grantedContactId" IS NOT NULL AND "fleetId" IS NULL)
    OR ("grantedContactId" IS NULL AND "fleetId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "PortalAccessGrant_contact_key" ON "PortalAccessGrant"("viewerContactId", "grantedContactId") WHERE "grantedContactId" IS NOT NULL;
CREATE UNIQUE INDEX "PortalAccessGrant_fleet_key" ON "PortalAccessGrant"("viewerContactId", "fleetId") WHERE "fleetId" IS NOT NULL;
CREATE INDEX "PortalAccessGrant_viewer_idx" ON "PortalAccessGrant"("viewerContactId", "active");
ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_viewerContactId_fkey" FOREIGN KEY ("viewerContactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_grantedContactId_fkey" FOREIGN KEY ("grantedContactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_fleetId_fkey" FOREIGN KEY ("fleetId") REFERENCES "Fleet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CustomerCase" (
  "id" TEXT NOT NULL,
  "number" BIGSERIAL NOT NULL,
  "subject" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'support',
  "category" TEXT,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'new',
  "source" TEXT NOT NULL DEFAULT 'portal',
  "contactId" TEXT NOT NULL,
  "vehicleId" TEXT,
  "warrantyClaimId" TEXT,
  "assignedToId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "CustomerCase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerCase_number_key" ON "CustomerCase"("number");
CREATE INDEX "CustomerCase_contact_status_idx" ON "CustomerCase"("contactId", "status", "createdAt");
CREATE INDEX "CustomerCase_vehicle_idx" ON "CustomerCase"("vehicleId", "createdAt");
ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CustomerCaseMessage" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "contactId" TEXT,
  "userId" TEXT,
  "direction" TEXT NOT NULL DEFAULT 'customer',
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "CustomerCaseMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CustomerCaseMessage_case_created_idx" ON "CustomerCaseMessage"("caseId", "createdAt");
ALTER TABLE "CustomerCaseMessage" ADD CONSTRAINT "CustomerCaseMessage_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CustomerCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerCaseMessage" ADD CONSTRAINT "CustomerCaseMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerCaseMessage" ADD CONSTRAINT "CustomerCaseMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PortalNotification" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "href" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'info',
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalNotification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PortalNotification_contact_read_idx" ON "PortalNotification"("contactId", "readAt", "createdAt");
ALTER TABLE "PortalNotification" ADD CONSTRAINT "PortalNotification_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PortalProfileChangeRequest" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "changes" JSONB NOT NULL,
  "note" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  CONSTRAINT "PortalProfileChangeRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PortalProfileChangeRequest_contact_idx" ON "PortalProfileChangeRequest"("contactId", "status", "createdAt");
ALTER TABLE "PortalProfileChangeRequest" ADD CONSTRAINT "PortalProfileChangeRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortalProfileChangeRequest" ADD CONSTRAINT "PortalProfileChangeRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PortalPreference" (
  "contactId" TEXT NOT NULL,
  "serviceReminders" BOOLEAN NOT NULL DEFAULT true,
  "portalNotifications" BOOLEAN NOT NULL DEFAULT true,
  "marketingEmail" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalPreference_pkey" PRIMARY KEY ("contactId")
);
ALTER TABLE "PortalPreference" ADD CONSTRAINT "PortalPreference_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PortalUpload" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "caseId" TEXT,
  "vehicleId" TEXT,
  "fileName" TEXT NOT NULL,
  "storedName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortalUpload_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PortalUpload_contact_created_idx" ON "PortalUpload"("contactId", "createdAt");
ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "CustomerCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "PortalAccessGrant" ("id", "viewerContactId", "fleetId", "role", "active")
SELECT 'fleet-manager-' || f."id", f."contactId", f."id", 'manager', true
FROM "Fleet" f
WHERE f."deletedAt" IS NULL AND f."contactId" IS NOT NULL
ON CONFLICT DO NOTHING;
