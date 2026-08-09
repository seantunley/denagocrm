-- Immutable publication snapshots for chatbot flows.
CREATE TABLE "BotFlowVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlowVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotFlowVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    -- Published snapshots outlive the mutable draft row. Restrict deletion of a
    -- BotFlow once it has versions so a live session's pinned version cannot be
    -- removed underneath it.
    CONSTRAINT "BotFlowVersion_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "BotFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BotFlowVersion_tenant_flow_version_key"
    ON "BotFlowVersion"("tenantId", "flowId", "version");
CREATE INDEX "BotFlowVersion_tenant_channel_created_idx"
    ON "BotFlowVersion"("tenantId", "channel", "createdAt");
CREATE INDEX "BotFlowVersion_flowId_idx" ON "BotFlowVersion"("flowId");

CREATE TABLE "BotFlowPublication" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotFlowPublication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BotFlowPublication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotFlowPublication_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "BotFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotFlowPublication_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "BotFlowVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- This is the hard invariant the old active Boolean could not provide under
-- concurrent publication: one live snapshot for each tenant + channel.
CREATE UNIQUE INDEX "BotFlowPublication_tenant_channel_key"
    ON "BotFlowPublication"("tenantId", "channel");
CREATE INDEX "BotFlowPublication_flowId_idx" ON "BotFlowPublication"("flowId");
CREATE INDEX "BotFlowPublication_versionId_idx" ON "BotFlowPublication"("versionId");

ALTER TABLE "BotFlowVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "BotFlowVersion_tenant_isolation" ON "BotFlowVersion"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "BotFlowVersion" FORCE ROW LEVEL SECURITY;

ALTER TABLE "BotFlowPublication" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "BotFlowPublication_tenant_isolation" ON "BotFlowPublication"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "BotFlowPublication" FORCE ROW LEVEL SECURITY;
