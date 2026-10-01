import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SETTINGS_TABS, settingsHref } from "../src/lib/settings-navigation";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";

// Batch 6 (Sean, 2026-10-01: "1A 2A"): integration credentials had two screens —
// the owner-only Settings → Integrations tab writing AppSetting, and "Integration
// overrides" writing TenantIntegrationCredential. One page now, at
// /settings/integrations; a save writes the workspace's own credential and every
// field shows where the value in use comes from.
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = src("src/app/(app)/settings/integrations/page.tsx");
const rows = src("src/components/settings/WorkspaceIntegrationRows.tsx");

test("both old addresses land on the one page", () => {
  assert.match(src("src/app/(app)/settings/integration-overrides/page.tsx"), /redirect\("\/settings\/integrations"\);/);
  const settings = src("src/app/(app)/settings/page.tsx");
  assert.match(settings, /if \(requestedTab === "integrations"\) \{/);
  assert.match(settings, /redirect\(`\/settings\/integrations\$\{query \? `\?\$\{query\}` : ""\}`\);/);
  assert.doesNotMatch(settings, /tab === "integrations" &&/, "the old tab's forms are gone");
  // The X OAuth round trip reports straight to the page.
  for (const route of ["src/app/api/integrations/x/connect/route.ts", "src/app/api/integrations/x/callback/route.ts"]) {
    assert.doesNotMatch(src(route), /tab=integrations/);
  }
});

test("a tenant owner can complete X sign-in from the page that offers it", () => {
  // Review of #742: the page is open to tenant owners and shows "Connect X
  // account", but both OAuth routes demanded the platform owner.
  for (const route of ["src/app/api/integrations/x/connect/route.ts", "src/app/api/integrations/x/callback/route.ts"]) {
    const code = src(route);
    assert.match(code, /await requireTenantOwner\(\);/);
    assert.doesNotMatch(code, /await requireOwner\(\)/);
  }
  // Still bound to the workspace that started it.
  const callback = src("src/app/api/integrations/x/callback/route.ts");
  assert.match(callback, /activeTenantId !== pending\.tenantId \|\| url\.searchParams\.get\("state"\) !== pending\.state/);
  assert.match(callback, /exchangeXCode\(\{ tenantId: activeTenantId,/);
  const x = src("src/lib/x.ts");
  assert.match(x, /if \(claimed && claimed\.tenantId !== input\.tenantId\)/);
});

test("one nav entry, open to tenant owners", () => {
  const entries = SETTINGS_TABS.filter((item) => /integration/.test(item.key));
  assert.deepEqual(entries.map((item) => item.key), ["integrations"]);
  assert.equal(settingsHref(entries[0]), "/settings/integrations");
  assert.equal(entries[0].everyone, true);
  assert.match(page, /const user = await requireTenantOwner\(\);/);
});

test("the platform owner's rows are owner-only and never edit a per-workspace credential", () => {
  assert.match(page, /const isPlatformOwner = user\.role === "owner";/);
  assert.match(page, /\{isPlatformOwner && \(\s*<section[^>]*>\s*<WorkspaceIntegrationRows /);
  // Those keys have exactly one form: the page's own, which writes the override.
  const keys = TENANT_CREDENTIAL_INTEGRATIONS.flatMap((integration) => integration.fields.map((field) => field.key));
  for (const key of keys) {
    assert.doesNotMatch(rows, new RegExp(`value="${key}"`), `${key} must not get a second (AppSetting) form`);
  }
});

test("each field's source follows the senders' all-or-nothing bundle rule", () => {
  // Own values count only once every required field is set (status "active").
  assert.match(page, /const ownInUse = status === "active";/);
  assert.match(page, /const source = ownInUse && isSet \? "own" : effectiveSet\[field\.key\] \? "default" : "unset";/);
  assert.match(page, /const savedNotInUse = isSet && !ownInUse;/);
  // "Platform default" only when the default is really there.
  assert.match(page, /\) : defaultInUse \? \(\s*<span className="badge bg-muted text-muted-foreground">Platform default<\/span>/);
});

test("Google reviews is read the way its fetcher reads it", () => {
  assert.match(src("src/app/(app)/inbox/page.tsx"), /resolveIntegrationBundle\(workspaceTenantId, "google-reviews"\)/);
  assert.match(src("src/lib/integrationHealth.ts"), /resolveIntegrationBundle\(currentTenantScope\(\)\?\.tenantId \?\? null, "google-reviews"\)/);
  assert.doesNotMatch(src("src/lib/integrationHealth.ts"), /getSetting\("GOOGLE_PLACE/);
});

test("saves refresh the page they were made on", () => {
  const settingsActions = src("src/app/actions/settings.ts");
  for (const fn of ["saveSetting", "clearSecret", "regenerateSetting"]) {
    const at = settingsActions.indexOf(`export async function ${fn}(`);
    const body = settingsActions.slice(at, settingsActions.indexOf("\nexport async function ", at + 10));
    assert.match(body, /revalidatePath\("\/settings", "layout"\);/, `${fn} must refresh /settings/integrations too`);
  }
  for (const file of ["src/app/actions/tenantCredentials.ts", "src/app/actions/integrationFlow.ts"]) {
    assert.match(src(file), /const OVERRIDES_PATH = "\/settings\/integrations";/);
  }
  assert.match(src("src/app/actions/bot.ts"), /revalidatePath\("\/settings\/integrations"\);/);
});
