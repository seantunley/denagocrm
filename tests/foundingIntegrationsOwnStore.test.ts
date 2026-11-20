import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sean, 2026-11-20: "Why are Google reviews shared? They should be per workspace?" — they were Denago's own, in the
// store from before workspaces had their own. They were moved into Denago's own store (prod, copy only) and the
// screens now say what is true. Nothing may write mail settings to the old store again.

const src = (f: string) => readFileSync(f, "utf8");

test("nothing on screen calls a workspace's settings 'shared'", () => {
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.doesNotMatch(page, /shared setup/i);
  assert.match(page, /Using this workspace&apos;s original settings|Using this workspace's original settings/);
  assert.match(src("src/lib/integrationsCatalogue.ts"), /shared: "Using original settings",/);
});

test("Settings → Email no longer has mail forms that wrote the old store — it shows the real status and points to Integrations", () => {
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.doesNotMatch(settings, /saveSmtpSettings|saveImapSettings|settingKey="(SMTP|IMAP)_PASS"/);
  assert.match(settings, /resolveIntegrationBundle\(signingTenantId, "smtp"\), resolveIntegrationBundle\(signingTenantId, "imap"\)/);
  assert.match(settings, /Settings → Integrations → Outbound email/);
  assert.match(settings, /Settings → Integrations → Inbound email/);
  const actions = src("src/app/actions/emails.ts");
  assert.doesNotMatch(actions, /export async function (saveSmtpSettings|saveImapSettings)/);
  assert.doesNotMatch(actions, /putSetting\(key, value\)[\s\S]{0,40}SMTP_|IMAP_HOST: String\(formData/);
});
