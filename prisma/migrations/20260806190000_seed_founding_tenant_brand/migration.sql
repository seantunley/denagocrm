-- =============================================================================
-- DENAGO BECOMES A TENANT LIKE ANY OTHER
-- =============================================================================
--
-- Until now the platform's built-in fallbacks WERE Denago: DEFAULT_BRAND said
-- "Denago Cape Town", COMPANY_DEFAULTS carried their address and phone, and the
-- signature template had their landline typed into it. That was right when there
-- was one customer. On a white-label platform it means an unrecognised hostname
-- shows one customer's trading name to another customer's visitors, and the
-- failure mode of a branding system should be anonymity rather than somebody
-- else's brand.
--
-- The code change that makes the fallbacks neutral is only safe if Denago is
-- already getting its identity from its own rows. This is that seed. It ships in
-- the SAME deploy, and it runs first: vercel.json is
-- `apply-migrations && next build`, so this data is committed while the PREVIOUS
-- build is still serving, and the new build only takes over afterwards. At no
-- point is there a version of the app running against a database without it.
--
-- Verified against production, read-only, 2026-08-06:
--   Tenant                     → exactly one row, 'tenant_denago_cpt'
--   AppSetting WHERE COMPANY_% → ZERO rows
--
-- That second line is why this migration is required rather than tidy. With no
-- COMPANY_* settings, every document Denago prints today gets its name, address,
-- phone and email from COMPANY_DEFAULTS. Neutralising that constant without this
-- seed would blank the footer of every quote, job card and signed agreement.
--
-- Everything below is additive and conditional. Nothing overwrites a value that
-- has already been set by a human.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The brand a platform admin would have typed into the console
-- -----------------------------------------------------------------------------
-- Only where it is still NULL. If a platform admin has already branded this
-- tenant, their choice is the one that stands — this is a backfill of a default,
-- not a correction.
--
-- No colour and no logo. brandPrimary stays NULL because "no override" is not
-- the same as a colour, and the app's own --primary is already what renders.
-- brandLogoRef stays NULL because the built-in asset is what displays today and
-- pointing it at a blob that has not been uploaded would break the header.
UPDATE "Tenant"
SET "brandDisplayName" = COALESCE("brandDisplayName", 'Denago Cape Town'),
    "brandTagline"     = COALESCE("brandTagline", 'Authorized Denago EV Dealer')
WHERE "id" = 'tenant_denago_cpt';


-- -----------------------------------------------------------------------------
-- 2. The hostname, VERIFIED  ← without this the login page goes neutral
-- -----------------------------------------------------------------------------
-- brandForHost() requires `verifiedAt IS NOT NULL`, and it is set here rather
-- than left for the console because this hostname needs no proving: it is the
-- origin this migration is being deployed to. A domain someone types into the
-- console is a claim; this one is a fact.
--
-- IF DENAGO IS REACHABLE ON ANY OTHER HOSTNAME, ADD IT IN THE CONSOLE BEFORE
-- MERGING. A hostname that is not in this table resolves to nobody, and after
-- this deploy "nobody" renders neutral instead of Denago.
INSERT INTO "TenantDomain" ("id", "tenantId", "hostname", "verifiedAt")
VALUES ('tdom_denago_primary', 'tenant_denago_cpt', 'crm.denagocpt.co.za', NOW())
ON CONFLICT ("hostname") DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. The Company Profile  ← the values every document currently prints
-- -----------------------------------------------------------------------------
-- Lifted verbatim from COMPANY_DEFAULTS as it stands in companyBrand.ts at this
-- commit, so a Denago document rendered after this deploy is byte-for-byte the
-- one rendered before it. The constant goes neutral in the same change; this is
-- where its content moves TO, not a new set of values.
--
-- ON CONFLICT DO NOTHING: an owner who has already edited Settings → Company
-- keeps what they typed. (Confirmed zero such rows on production today, so in
-- practice every one of these inserts.)
--
-- COMPANY_FACEBOOK is omitted deliberately: it is empty in COMPANY_DEFAULTS, and
-- seeding an empty string turns "not set" into "explicitly blank", which reads
-- differently in Settings.
--
-- COMPANY_LOGO_URL is NOT omitted, and it is the one row here that is not a
-- straight copy. The email signature resolved its logo as
-- `profile.logoUrl || DEFAULT_SIGNATURE_COMPANY.logoUrl`, and that second
-- operand used to be the built-in Denago asset. It is empty now, so without this
-- row every Denago signature would go out with no logo at all — the one part of
-- this change that would have degraded rather than just renamed. Absolute,
-- because a mail client has no origin to resolve a path against.
INSERT INTO "AppSetting" ("key", "value", "tenantId") VALUES
  ('COMPANY_NAME',      'Denago Cape Town',                                        'tenant_denago_cpt'),
  ('COMPANY_TAGLINE',   'Authorized Denago EV Dealer',                             'tenant_denago_cpt'),
  ('COMPANY_ADDRESS',   'Unit 55, M5 Freeway Business Park, Maitland, Cape Town',  'tenant_denago_cpt'),
  ('COMPANY_PHONE',     '073 789 3438',                                            'tenant_denago_cpt'),
  ('COMPANY_EMAIL',     'sales@denagocpt.co.za',                                   'tenant_denago_cpt'),
  ('COMPANY_WEBSITE',   'denagocpt.co.za',                                         'tenant_denago_cpt'),
  ('COMPANY_INSTAGRAM', '@denago_capetown',                                        'tenant_denago_cpt'),
  ('COMPANY_LOGO_URL',  'https://crm.denagocpt.co.za/branding/denago-logo-email.png', 'tenant_denago_cpt')
ON CONFLICT ("tenantId", "key") DO NOTHING;


-- -----------------------------------------------------------------------------
-- 4. What is NOT seeded
-- -----------------------------------------------------------------------------
-- The email signature's social links (facebook.com/profile.php?id=…,
-- instagram.com/denago_capetown/) are not moved here, because the Company
-- Profile has no field for a full social URL — only the @handle. They stay in
-- DEFAULT_SIGNATURE_COMPANY for now, which means a second tenant's signature
-- would link to Denago's socials. That is a real gap and it needs a schema
-- field, so it is recorded rather than half-fixed here.
