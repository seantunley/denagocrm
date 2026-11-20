import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";
import { imapUsable, mailSetupLabel, smtpUsable } from "../src/lib/integrationsCatalogue";

// Sean, 2026-11-20: "Why are Google reviews shared? They should be per workspace?" — they were Denago's own, in the
// store from before workspaces had their own. They were moved into Denago's own store (prod, copy only) and the
// screens now say what is true. Nothing may write mail settings to the old store again.

const src = (f: string) => readFileSync(f, "utf8");

test("mail readiness: partial original settings read 'Incomplete', never 'Set up'", () => {
  assert.equal(smtpUsable({ SMTP_HOST: "mail.example.com", SMTP_FROM: null }), false, "a host without From can't send");
  assert.equal(smtpUsable({ SMTP_HOST: "mail.example.com", SMTP_FROM: "sales@example.com" }), true);
  assert.equal(imapUsable({ IMAP_HOST: "mail.example.com", IMAP_USER: "crm@example.com", IMAP_PASS: null }), false, "no password: the sync exits");
  assert.equal(imapUsable({ IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASS: "p" }), true);
  assert.equal(smtpUsable(null), false);
  assert.equal(mailSetupLabel(false, true), "Incomplete");
  assert.equal(mailSetupLabel(false, false), "Not set up");
  assert.equal(mailSetupLabel(true, true), "Set up");
});

test("nothing on screen calls a workspace's settings 'shared' — the page AND the descriptions it renders", () => {
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.doesNotMatch(page, /shared setup/i);
  // Review of #1158: the cards render each integration's description — those said "instead of the platform's shared one".
  for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
    assert.doesNotMatch(`${integration.label} ${integration.description}`, /shared|platform's/i, integration.id);
  }
  // Only the founding workspace is told about original settings — the same rule as resolveIntegrationBundle, in every
  // enforcement mode (review of #1158: off/monitor showed it to every workspace).
  assert.match(page, /const usesPlatformFallback = tenantId === DEFAULT_TENANT_ID;/);
  assert.doesNotMatch(page, /tenantEnforcing\(\)/);
  assert.match(page, /Using this workspace&apos;s original settings|Using this workspace's original settings/);
  assert.match(src("src/lib/integrationsCatalogue.ts"), /shared: "Using original settings",/);
});

test("Settings → Email no longer has mail forms that wrote the old store — it shows the real status and points to Integrations", () => {
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.doesNotMatch(settings, /saveSmtpSettings|saveImapSettings|settingKey="(SMTP|IMAP)_PASS"/);
  assert.match(settings, /resolveIntegrationBundle\(signingTenantId, "smtp"\), resolveIntegrationBundle\(signingTenantId, "imap"\)/);
  assert.match(settings, /Settings → Integrations → Outbound email/);
  assert.match(settings, /Settings → Integrations → Inbound email/);
  // Review of #1158: "Set up" only when the mail code could run — the one rule, shared with the send and sync paths.
  assert.match(settings, /mailSetupLabel\(smtpUsable\(smtpMail\)/);
  assert.match(settings, /mailSetupLabel\(imapUsable\(imapMail\)/);
  assert.match(src("src/lib/email.ts"), /if \(!smtpUsable\(bundle\.values\) \|\| !host \|\| !from\) return null;/);
  assert.match(src("src/lib/imapSync.ts"), /if \(!imapUsable\(bundle\) \|\| !host \|\| !user \|\| !pass\) return 0;/);
  const actions = src("src/app/actions/emails.ts");
  assert.doesNotMatch(actions, /export async function (saveSmtpSettings|saveImapSettings)/);
  assert.doesNotMatch(actions, /putSetting\(key, value\)[\s\S]{0,40}SMTP_|IMAP_HOST: String\(formData/);
});
