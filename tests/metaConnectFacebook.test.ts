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
  const connect = lib.slice(lib.indexOf("async function connectMetaPageLocked"));
  const refused = connect.indexOf("already connected to another workspace");
  const subscribe = connect.indexOf("/subscribed_apps`");
  const store = connect.indexOf("await putTenantCredentialBundle(");
  assert.ok(refused > 0 && refused < subscribe && subscribe < store, "refuse → subscribe → store");
  assert.match(connect, /if \(!subscribed\.ok \|\| result\?\.success !== true\) throw new Error\(/);
  // Review of #1182: CLAIMED atomically (lib/channelClaim.ts) before Meta is asked or a token stored; what this call
  // newly took is released on any later failure; after registering, every endpoint must be active and ours, or the
  // connection is removed — a losing workspace never keeps a usable token.
  assert.match(connect, /if \(!\(await claimChannelEndpoint\(input\.tenantId, endpoint\.channel, endpoint\.externalId, endpoint\.label\)\)\) \{\s*await release\(\);\s*throw new Error\(endpoint\.refusal\);/);
  assert.ok(connect.indexOf("claimChannelEndpoint(") < connect.indexOf("/subscribed_apps`"));
  // Second review: EVERY step after the claim — subscribe, store, clear blanks, register, verify — sits in one try whose
  // catch restores the previous connection row for row, releases what was newly claimed and re-registers.
  const tryAt = connect.indexOf("  try {\n    const subscribed");
  const catchAt = connect.indexOf("  } catch (error) {");
  for (const step of ["/subscribed_apps`", "await putTenantCredentialBundle(", "if (blanks.length)", "await reconcileTenantChannels(input.tenantId, { force: true });", "throw new Error(endpoint.refusal);\n    }\n  }"]) {
    const at = connect.indexOf(step, tryAt);
    assert.ok(tryAt > 0 && at > tryAt && at < catchAt, `inside the compensated block: ${step}`);
  }
  assert.match(connect, /const previous = await basePrisma\.tenantIntegrationCredential\.findMany\(\{ where: \{ tenantId: input\.tenantId, key: \{ in: keys \} \}, select: \{ key: true, value: true \} \}\);/);
  assert.match(connect, /\} catch \(error\) \{[\s\S]*?\.\$transaction\(async \(tx\) => \{\s*await tx\.tenantIntegrationCredential\.deleteMany\(\{ where: \{ tenantId: input\.tenantId, key: \{ in: keys \} \} \}\);\s*if \(previous\.length\) await tx\.tenantIntegrationCredential\.createMany\(/);
  assert.match(connect, /await release\(\)\.catch\(\(\) => \{\}\);\s*await reconcileTenantChannels\(input\.tenantId, \{ force: true \}\)\.catch\(\(\) => \{\}\);\s*throw error;/);
  assert.doesNotMatch(connect.slice(0, connect.indexOf("async function disconnectMetaPageLocked")), /\$transaction\(\[/, "basePrisma refuses the array form");
  // …and one Connect or Disconnect at a time per workspace (a lease row; real-DB race in scripts/test-channel-claim.ts).
  assert.match(lib, /export function connectMetaPage\(input: \{ tenantId: string; pageId: string \}\): Promise<string> \{\s*return withMetaConnectLock\(input\.tenantId, \(\) => connectMetaPageLocked\(input\)\);/);
  assert.match(lib, /export function disconnectMetaPage\(tenantId: string\): Promise<string \| null> \{\s*return withMetaConnectLock\(tenantId, \(\) => disconnectMetaPageLocked\(tenantId\)\);/);
  assert.doesNotMatch(connect, /channelIdentity\.upsert\(/);
  // The state is consumed once: only the request whose delete removed it may go on.
  assert.match(lib, /const \{ count \} = await basePrisma\.appSetting\.deleteMany\(\{ where: \{ tenantId: input\.tenantId, key \} \}\);\s*const record = saved && count === 1 \?/);
  // The public return leg is named in the security registry, exactly.
  assert.match(code("tests/apiAuth.test.ts"), /"integrations\/meta\/callback\/",/);
  assert.match(connect, /await reconcileTenantChannels\(input\.tenantId, \{ force: true \}\);/);
  // Disconnect: unsubscribed, every connected key forgotten, endpoints released.
  const disconnect = lib.slice(lib.indexOf("async function disconnectMetaPageLocked"));
  assert.match(disconnect, /method: "DELETE"/);
  assert.match(disconnect, /key: \{ in: Object\.values\(CONNECTED\) \}/);
  assert.match(disconnect, /await reconcileTenantChannels\(tenantId, \{ force: true \}\);/);
  // Owner-only actions, audited.
  const actions = code("src/app/actions/metaConnect.ts");
  assert.equal(actions.match(/await requireTenantOwner\(\);/g)?.length, 2);
  assert.match(actions, /action: "integration\.meta_connected"/);
  assert.match(actions, /action: "integration\.meta_disconnected"/);
});
