-- Forced row-level security for every signing trust table.

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'SigningUploadIntent','SigningArtifact','LegalArtifact','SigningOutboxJob','SigningDelivery',
    'SigningIdentityChallenge','SigningEvidenceAnchor','LegalArtifactDestructionRequest','SigningRecoveryAction'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I',table_name||'_tenant_policy',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (current_setting(''app.bypass_rls'',true)=''on'' OR "tenantId"=NULLIF(current_setting(''app.current_tenant'',true),'''')) WITH CHECK (current_setting(''app.bypass_rls'',true)=''on'' OR "tenantId"=NULLIF(current_setting(''app.current_tenant'',true),''''))',
      table_name||'_tenant_policy',table_name
    );
  END LOOP;
END $$;

ALTER TABLE "SignatureRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignatureRequest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SignatureRecipient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignatureRecipient" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SignatureField" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignatureField" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SignatureFieldResponse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignatureFieldResponse" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SignatureEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignatureEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalStep" FORCE ROW LEVEL SECURITY;
