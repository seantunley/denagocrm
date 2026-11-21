import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isSecretSettingKey } from "../src/lib/settings";

/**
 * CONNECT FACEBOOK (Sean, 2026-11-21: "then yes, a reviewer can get a login … Build this and lets test it" —
 * DenagoCRM_Meta_Commercial_App_Review_Steps.md, one Page per workspace; "as long as I can whitelabel the domain").
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("every reader of the Meta token goes through metaPageCredential — a connected Page is used everywhere at once", () => {
  const page = code("src/lib/metaPage.ts");
  // Connected wins; the pasted System User token is the fallback, as before.
  assert.ok(page.indexOf("CONNECTED.pageToken") < page.indexOf('"META_PAGE_ACCESS_TOKEN"'));
  assert.match(page, /if \(pageToken && pageId\) \{/);
  for (const [file, pattern] of [
    ["src/lib/messenger.ts", /const credential = await metaPageCredential\(tenantId\);\s*\/\/[^\n]*\n\s*if \(credential\?\.kind === "connected"\) return credential\.pageToken;/],
    ["src/lib/messenger.ts", /return Boolean\(await metaPageCredential\(ambientTenantId\(\)\)\);/],
    ["src/lib/metaLeadSync.ts", /const credential = await metaPageCredential\(tenantId\);/],
    ["src/lib/metaCapabilities.ts", /const credential = await metaPageCredential\(currentTenantScope\(\)\?\.tenantId \?\? null\);/],
    ["src/app/api/webhooks/meta/route.ts", /const accessToken = metaLeadToken\(await metaPageCredential\(currentTenantScope\(\)\?\.tenantId \?\? null\)\);/],
    ["src/lib/channelRegistration.ts", /const meta = await metaPageCredential\(tenantId\);/],
  ] as const) assert.match(code(file), pattern, file);
  // No reader left reading the old key directly (the discovery-wanted check only asks whether one exists).
  for (const file of ["src/lib/messenger.ts", "src/lib/metaLeadSync.ts", "src/lib/metaCapabilities.ts", "src/app/api/webhooks/meta/route.ts"]) {
    assert.doesNotMatch(code(file), /resolveTenantCredential\([^)]*"META_PAGE_ACCESS_TOKEN"\)/, file);
  }
});

test("a connected Page is never retired by the 'no System User token' path", () => {
  const reg = code("src/lib/channelRegistration.ts");
  const connected = reg.indexOf('if (meta?.kind === "connected") {');
  const discovery = reg.indexOf("metaEndpointsFrom(pageToken");
  assert.ok(connected > 0 && connected < discovery, "the connected branch comes first");
  assert.match(reg, /\} else if \(opts\.force \|\| \(\(await missingMetaChannels\(tenantId\)\)\.length > 0 && discoveryAllowed\)\) \{/, "discovery only when NOT connected");
  assert.match(code("src/lib/metaPage.ts"), /\{ channel: "messenger", externalId: credential\.pageId, label: credential\.pageName \},/);
});

test("white-label safe: the platform callback only forwards; /finish on the starting domain checks session + same-browser state", () => {
  const lib = code("src/lib/metaConnect.ts");
  // Started only from the platform's own address or THIS workspace's verified domain.
  assert.match(lib, /tenantDomain\.findFirst\(\{ where: \{ tenantId, hostname: url\.hostname\.toLowerCase\(\), verifiedAt: \{ not: null \} \}/);
  assert.match(code("src/app/api/integrations/meta/connect/route.ts"), /if \(!\(await connectOriginAllowed\(tenantId, origin\)\)\) return/);
  // One-time state: workspace id + 32 random bytes, stored HASHED server-side with the origin, 10 minutes.
  assert.match(lib, /const state = `\$\{input\.tenantId\}\.\$\{crypto\.randomBytes\(32\)\.toString\("base64url"\)\}`;/);
  assert.match(lib, /const STATE_TTL_MS = 10 \* 60 \* 1000;/);
  assert.match(lib, /redirect_uri: metaCallbackUrl\(\)/);
  // The callback forwards to the STORED origin, connects nothing, needs no session.
  const callback = code("src/app/api/integrations/meta/callback/route.ts");
  assert.match(callback, /const origin = await metaConnectReturnOrigin\(state\);/);
  assert.doesNotMatch(callback, /connectMetaPage|finishMetaConnect|putTenantCredential/);
  const proxy = code("src/proxy.ts");
  assert.match(proxy, /"\/api\/integrations\/meta\/callback",/);
  assert.doesNotMatch(proxy, /"\/api\/integrations\/meta\/(finish|connect)"/, "only the forwarder is public");
  // Finish: the owner's session, the cookie set on THIS domain must equal the state, then the state is spent.
  const finish = code("src/app/api/integrations/meta/finish/route.ts");
  assert.match(finish, /const user = await requireTenantOwner\(\);/);
  assert.match(finish, /if \(!tenantId \|\| !cookieState \|\| cookieState !== state\) return back\("invalid"\);/);
  assert.ok(lib.indexOf("await basePrisma.appSetting.deleteMany({ where: { tenantId: input.tenantId, key } });") < lib.indexOf('graph("oauth/access_token"'), "spent before it is used");
  assert.match(code("src/app/api/integrations/meta/connect/route.ts"), /jar\.set\("meta_oauth", started\.state, \{ httpOnly: true, secure: true, sameSite: "lax"/);
});

test("connecting: tokens never reach the browser, another workspace's Page is refused, the subscription is proven first", () => {
  assert.equal(isSecretSettingKey("META_CONNECTED_PAGE_TOKEN"), true);
  assert.equal(isSecretSettingKey("META_CONNECT_PENDING"), true, "the Pages awaiting the pick carry tokens");
  const lib = code("src/lib/metaConnect.ts");
  assert.match(lib, /return pending \? pending\.pages\.map\(\(page\) => \(\{ id: page\.id, name: page\.name, igUsername: page\.igUsername \}\)\) : null;/, "the picker gets names and ids only");
  const connect = lib.slice(lib.indexOf("export async function connectMetaPage"));
  const refused = connect.indexOf("already connected to another workspace");
  const subscribe = connect.indexOf("/subscribed_apps`");
  const store = connect.indexOf("await putTenantCredentialBundle(");
  assert.ok(refused > 0 && refused < subscribe && subscribe < store, "refuse → subscribe → store");
  assert.match(connect, /if \(!subscribed\.ok \|\| result\?\.success !== true\) throw new Error\(/);
  assert.match(connect, /await reconcileTenantChannels\(input\.tenantId, \{ force: true \}\);/);
  // Disconnect: unsubscribed, every connected key forgotten, endpoints released.
  const disconnect = lib.slice(lib.indexOf("export async function disconnectMetaPage"));
  assert.match(disconnect, /method: "DELETE"/);
  assert.match(disconnect, /key: \{ in: Object\.values\(CONNECTED\) \}/);
  assert.match(disconnect, /await reconcileTenantChannels\(tenantId, \{ force: true \}\);/);
  // Owner-only actions, audited.
  const actions = code("src/app/actions/metaConnect.ts");
  assert.equal(actions.match(/await requireTenantOwner\(\);/g)?.length, 2);
  assert.match(actions, /action: "integration\.meta_connected"/);
  assert.match(actions, /action: "integration\.meta_disconnected"/);
});
