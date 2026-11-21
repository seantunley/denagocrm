import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";

/**
 * Sean, 2026-11-21: "Each workspace will have its own" Meta app (Breastfeeding Art's Instagram, under its own app and
 * App Review). Its app delivers to /api/webhooks/meta?workspace=<slug>, is checked with ITS secret and verify token,
 * and its events reach only its own Page / Instagram account. Without ?workspace the platform's app, exactly as before.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("the workspace's Meta form has its own app's secret and verify token: optional, independent, encrypted", () => {
  const meta = TENANT_CREDENTIAL_INTEGRATIONS.find((integration) => integration.id === "meta")!;
  for (const key of ["META_OWN_APP_SECRET", "META_OWN_VERIFY_TOKEN"]) {
    const field = meta.fields.find((f) => f.key === key);
    assert.ok(field, key);
    assert.equal(field!.required, false, `${key}: blank changes nothing for a workspace on the platform app`);
    assert.equal(field!.independent, true, `${key}: never makes the page-token set "incomplete"`);
  }
  // Separate keys from the platform app's, so the platform's META_APP_SECRET is never a workspace's.
  assert.match(code("src/lib/metaWorkspaceApp.ts"), /resolveTenantCredential\(tenant\.id, "META_OWN_APP_SECRET"\),\s*resolveTenantCredential\(tenant\.id, "META_OWN_VERIFY_TOKEN"\),/);
  assert.match(code("src/lib/settings.ts"), /"META_OWN_APP_SECRET",\s*"META_OWN_VERIFY_TOKEN",/);
});

test("the webhook: ?workspace= is checked with that workspace's own app, the platform app otherwise", () => {
  const route = code("src/app/api/webhooks/meta/route.ts");
  // Verify (GET) and signature (POST): the workspace's own values when named; an unknown workspace gets nothing.
  assert.match(route, /const own = workspace \? await validateInSystemScope\(\(\) => workspaceMetaApp\(workspace\)\) : null;\s*if \(workspace && !own\) return new NextResponse\("Verification failed", \{ status: 403 \}\);\s*const verifyToken = own \? own\.verifyToken : await validateInSystemScope\(\(\) => getSetting\("META_VERIFY_TOKEN"\)\);/);
  assert.match(route, /if \(workspace && !own\) return NextResponse\.json\(\{ error: "Unknown workspace" \}, \{ status: 404 \}\);\s*const only = \{ onlyTenantId: own\?\.tenantId \?\? null \};\s*const appSecret = own \? own\.appSecret : await validateInSystemScope\(\(\) => getSetting\("META_APP_SECRET"\)\);/);
  // Every per-event scope in the route is restricted to that workspace: DMs, Page comments, lead ads.
  const scopes = route.match(/withChannelTenantScope\(/g)?.length ?? 0;
  const restricted = route.match(/,\s*only,?\s*\)/g)?.length ?? 0;
  assert.equal(scopes, 3, "DMs, Page comments, lead ads");
  assert.equal(restricted, scopes, "every withChannelTenantScope call passes `only`");
  // An unknown or inactive slug resolves to nothing; slugs are checked before any lookup.
  const lib = code("src/lib/metaWorkspaceApp.ts");
  assert.match(lib, /if \(!\/\^\[a-z0-9-\]\{1,64\}\$\/\.test\(clean\)\) return null;/);
  assert.match(lib, /if \(!tenant\?\.active\) return null;/);
});

test("an event from a workspace's own app reaches only that workspace — another's endpoint or none is refused, in either mode", () => {
  const entry = code("src/lib/tenantScopeEntry.ts");
  const fn = entry.slice(entry.indexOf("export async function withChannelTenantScope"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /if \(opts\.onlyTenantId\) return tenantId === opts\.onlyTenantId \? runInTenantScope\(\{ tenantId, system: false \}, fn\) : onUnresolved\(\);/);
  // Checked before the ordinary paths, so the dormant "run unscoped" fallback can never apply to it.
  assert.ok(body.indexOf("opts.onlyTenantId") < body.indexOf("if (tenantId) return runInTenantScope"));
  assert.ok(body.indexOf("opts.onlyTenantId") < body.indexOf("tenantEnforcing()"));
});

test("Settings shows the workspace its own callback address and what to subscribe", () => {
  assert.match(code("src/app/(app)/settings/integrations/page.tsx"), /\{integration\.id === "meta" && <MetaOwnAppBox tenantId=\{tenantId\} \/>\}/);
  const box = code("src/components/settings/MetaOwnAppBox.tsx");
  assert.match(box, /workspaceMetaCallbackUrl\(appBaseUrl\(\), tenant\.slug\)/);
  assert.match(box, /<b>Instagram<\/b> to <b>messages<\/b> and <b>comments<\/b>/);
  assert.match(code("src/lib/metaWorkspaceApp.ts"), /\/api\/webhooks\/meta\?workspace=\$\{encodeURIComponent\(slug\)\}/);
});
