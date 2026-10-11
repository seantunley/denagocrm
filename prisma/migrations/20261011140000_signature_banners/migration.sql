-- Email signature banners: a marketing banner under the sender's signature,
-- with its schedule, who sends it, and its clicks. A click row holds no IP
-- address or browser string. Additive only.

CREATE TABLE IF NOT EXISTS "SignatureBanner" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "linkUrl" TEXT NOT NULL,
  "altText" TEXT NOT NULL DEFAULT '',
  "active" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "senderIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "teamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "position" TEXT NOT NULL DEFAULT 'below',
  "onQuoteEmails" BOOLEAN NOT NULL DEFAULT false,
  "token" TEXT NOT NULL,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SignatureBanner_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureBanner_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureBanner_token_key" ON "SignatureBanner"("token");
CREATE INDEX IF NOT EXISTS "SignatureBanner_tenantId_active_idx" ON "SignatureBanner"("tenantId", "active");

-- One row per destination a banner has had. Never updated, so a link already in
-- a customer's inbox keeps opening the page it was sent with.
CREATE TABLE IF NOT EXISTS "SignatureBannerLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bannerId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "linkUrl" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignatureBannerLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureBannerLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SignatureBannerLink_bannerId_fkey"
    FOREIGN KEY ("bannerId") REFERENCES "SignatureBanner"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureBannerLink_token_key" ON "SignatureBannerLink"("token");
CREATE INDEX IF NOT EXISTS "SignatureBannerLink_tenantId_bannerId_idx" ON "SignatureBannerLink"("tenantId", "bannerId");

CREATE TABLE IF NOT EXISTS "SignatureBannerClick" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "bannerId" TEXT NOT NULL,
  "communicationId" TEXT,
  "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignatureBannerClick_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureBannerClick_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SignatureBannerClick_bannerId_fkey"
    FOREIGN KEY ("bannerId") REFERENCES "SignatureBanner"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SignatureBannerClick_tenantId_bannerId_clickedAt_idx" ON "SignatureBannerClick"("tenantId", "bannerId", "clickedAt");
CREATE INDEX IF NOT EXISTS "SignatureBannerClick_communicationId_idx" ON "SignatureBannerClick"("communicationId");

-- The first click on the banner in a sent email, shown on that email's timeline entry.
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "bannerClickedAt" TIMESTAMP(3);
-- The email's own id inside its banner link — its own column, not the open
-- token, so a click is attributable whether or not open tracking is on.
ALTER TABLE "Communication" ADD COLUMN IF NOT EXISTS "bannerRef" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Communication_bannerRef_key" ON "Communication"("bannerRef");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. One workspace never reads or writes another's.
ALTER TABLE "SignatureBanner" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureBanner_tenant_isolation" ON "SignatureBanner";
CREATE POLICY "SignatureBanner_tenant_isolation" ON "SignatureBanner"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureBanner" FORCE ROW LEVEL SECURITY;

ALTER TABLE "SignatureBannerLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureBannerLink_tenant_isolation" ON "SignatureBannerLink";
CREATE POLICY "SignatureBannerLink_tenant_isolation" ON "SignatureBannerLink"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureBannerLink" FORCE ROW LEVEL SECURITY;

ALTER TABLE "SignatureBannerClick" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureBannerClick_tenant_isolation" ON "SignatureBannerClick";
CREATE POLICY "SignatureBannerClick_tenant_isolation" ON "SignatureBannerClick"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureBannerClick" FORCE ROW LEVEL SECURITY;
