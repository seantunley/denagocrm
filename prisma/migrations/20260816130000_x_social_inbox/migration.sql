ALTER TABLE "Contact" ADD COLUMN "xUserId" TEXT;
CREATE UNIQUE INDEX "Contact_tenantId_xUserId_key" ON "Contact"("tenantId", "xUserId");
CREATE UNIQUE INDEX "ChannelIdentity_one_active_x_per_tenant"
  ON "ChannelIdentity"("tenantId")
  WHERE "channel" = 'x' AND "disabledAt" IS NULL;

-- One account may belong to only one tenant. ChannelIdentity already enforces
-- this through its (channel, externalId) unique constraint; no new global table
-- or tenantless credential store is introduced.
