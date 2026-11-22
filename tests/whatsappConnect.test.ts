import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FACEBOOK_ORIGINS, SIGNUP_MESSAGE_TYPE, newRegistrationPin, parseMetaSignupEvent, parseSignupHandoff, validHandoff } from "../src/lib/whatsappSignupMessage";
import { isSecretSettingKey } from "../src/lib/settings";

/**
 * CONNECT WHATSAPP (Sean, 2026-11-21: "Build the WhatsApp PRs for the easy connect for new tenants") — Meta's Embedded
 * Signup v4 on the platform app, Honeycomb 360. Plan: CORVAYAN_WhatsApp_Embedded_Signup_Implementation.md.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const PLATFORM = "https://crm.honeycombventures.co.za";
const STATE = `cmwqtx5a60000uwq8zv0nr9r5.${"A".repeat(43)}`;
const finish = (data: Record<string, unknown> = { waba_id: "123456789", phone_number_id: "987654321" }) =>
  JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data });

test("Meta's session event is read only from facebook.com, and only FINISH with real ids counts", () => {
  assert.deepEqual(parseMetaSignupEvent("https://www.facebook.com", finish()), { kind: "finish", session: { wabaId: "123456789", phoneNumberId: "987654321" } });
  assert.deepEqual(FACEBOOK_ORIGINS, ["https://www.facebook.com", "https://web.facebook.com"]);
  // An exact origin — not "ends with facebook.com".
  for (const origin of ["https://evilfacebook.com", "https://facebook.com.evil.io", "http://www.facebook.com", PLATFORM]) {
    assert.equal(parseMetaSignupEvent(origin, finish()), null, origin);
  }
  assert.deepEqual(parseMetaSignupEvent("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" })), { kind: "cancel" });
  assert.deepEqual(parseMetaSignupEvent("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR" })), { kind: "error" });
  // The WhatsApp Business app (coexistence) finish is not supported here.
  assert.deepEqual(parseMetaSignupEvent("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" })), { kind: "unsupported" });
  assert.deepEqual(parseMetaSignupEvent("https://www.facebook.com", finish({ waba_id: "x", phone_number_id: "1" })), { kind: "error" });
  assert.equal(parseMetaSignupEvent("https://www.facebook.com", "not json"), null);
  assert.equal(parseMetaSignupEvent("https://www.facebook.com", JSON.stringify({ type: "OTHER" })), null);
});

test("the popup's handoff is accepted only from the platform's address, in the exact shape", () => {
  const good = { type: SIGNUP_MESSAGE_TYPE, state: STATE, code: "AQD-one-time-code-value", wabaId: "123456789", phoneNumberId: "987654321" };
  assert.deepEqual(parseSignupHandoff(PLATFORM, PLATFORM, good), { state: STATE, code: good.code, wabaId: "123456789", phoneNumberId: "987654321" });
  assert.equal(parseSignupHandoff("https://www.facebook.com", PLATFORM, good), null, "another origin");
  assert.equal(parseSignupHandoff(PLATFORM, PLATFORM, { ...good, type: "other" }), null);
  assert.equal(parseSignupHandoff(PLATFORM, PLATFORM, { ...good, state: "../../etc" }), null);
  assert.equal(parseSignupHandoff(PLATFORM, PLATFORM, { ...good, phoneNumberId: "1 OR 1=1" }), null);
  assert.equal(parseSignupHandoff(PLATFORM, PLATFORM, { ...good, code: "" }), null);
  // The server checks the same shape again, whatever the browser sent.
  assert.equal(validHandoff({ ...good, wabaId: undefined }), null);
});

test("the registration PIN is six digits, random, and stored encrypted", () => {
  assert.equal(newRegistrationPin(() => 42), "000042");
  assert.equal(newRegistrationPin(() => 999_999), "999999");
  assert.equal(isSecretSettingKey("WA_REGISTER_PINS"), true);
  assert.equal(isSecretSettingKey("WA_ACCESS_TOKEN"), true);
});

test("the PIN is saved BEFORE Meta registers the number, survives any failure or disconnect, and is reused (review of #1187)", () => {
  const lib = code("src/lib/whatsappConnect.ts");
  const connect = lib.slice(lib.indexOf("export async function connectWhatsAppNumber"), lib.indexOf("export async function connectedWhatsApp"));
  const saved = connect.indexOf("const pin = await registrationPin(input.tenantId, input.phoneNumberId);");
  assert.ok(saved > 0 && saved < connect.indexOf("/register`, token,"), "saved before the step that can't be undone");
  const helper = lib.slice(lib.indexOf("async function registrationPin"), lib.indexOf("export async function savedRegistrationPin"));
  assert.match(helper, /if \(\/\^\\d\{6\}\$\/\.test\(pins\[phoneNumberId\] \?\? ""\)\) return pins\[phoneNumberId\];/, "a retry reuses the same PIN");
  assert.match(helper, /await putTenantCredential\(tenantId, PINS_KEY, JSON\.stringify\(\{ \.\.\.pins, \[phoneNumberId\]: pin \}\)\);\s*return pin;/);
  // Not a connection key: the undo and Disconnect delete CONNECTION_KEYS only.
  assert.match(lib, /const PINS_KEY = "WA_REGISTER_PINS";/);
  assert.doesNotMatch(lib.slice(lib.indexOf("const CONNECTION_KEYS"), lib.indexOf("\n", lib.indexOf("const CONNECTION_KEYS"))), /PIN/);
  assert.match(code("src/components/settings/WhatsAppConnectBox.tsx"), /Two-step verification PIN for this number/);
});

test("connecting: state spent once, the number checked with Meta, claimed first, then subscribe → register → store, undone on any failure", () => {
  const lib = code("src/lib/whatsappConnect.ts");
  const connect = lib.slice(lib.indexOf("export async function connectWhatsAppNumber"), lib.indexOf("export async function connectedWhatsApp"));
  assert.match(connect, /const \{ count \} = await basePrisma\.appSetting\.deleteMany\(\{ where: \{ tenantId: input\.tenantId, key \} \}\);\s*const record = saved && count === 1 \?/);
  // The code is exchanged on the server with the app secret; the secret is never sent to a browser.
  assert.match(connect, /graph\("GET", "oauth\/access_token", null, undefined, \{ client_id: app\.appId, client_secret: app\.appSecret, code: input\.code \}\)/);
  assert.doesNotMatch(code("src/app/connect/whatsapp/page.tsx"), /appSecret=/);
  // The number must be in that account, as Meta tells THIS token — the browser's ids are not trusted.
  assert.match(connect, /graph\("GET", `\$\{input\.wabaId\}\/phone_numbers`, token,/);
  assert.match(connect, /\.find\(\(row\) => String\(row\.id\) === input\.phoneNumberId\);\s*if \(!phone\) throw new Error\(/);
  const order = ["claimChannelEndpoint(", "/subscribed_apps`, token)", "/register`, token,", "await putTenantCredentialBundle(", "await reconcileTenantChannels(input.tenantId, { force: true });"].map((step) => connect.indexOf(step));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `claim → subscribe → register → store → register endpoint: ${order}`);
  // Undo: previous WhatsApp restored in one (interactive) transaction, the number released when newly taken.
  assert.match(connect, /\} catch \(error\) \{[\s\S]*?\.\$transaction\(async \(tx\) => \{\s*await tx\.tenantIntegrationCredential\.deleteMany\(\{ where: \{ tenantId: input\.tenantId, key: \{ in: CONNECTION_KEYS \} \} \}\);/);
  assert.match(connect, /if \(!alreadyOurs\) \{\s*await basePrisma\.channelIdentity\.updateMany\(/);
  assert.doesNotMatch(lib, /\$transaction\(\[/, "basePrisma refuses the array form");
  // Stored in the ordinary WhatsApp fields, so sending and receiving work unchanged.
  assert.match(connect, /WA_PHONE_NUMBER_ID: input\.phoneNumberId,\s*WA_ACCESS_TOKEN: token,/);
});

test("the routes: owner session, same-browser cookie, nothing trusted beyond its shape", () => {
  const start = code("src/app/api/integrations/whatsapp/start/route.ts");
  assert.match(start, /const user = await requireTenantOwner\(\);/);
  assert.match(start, /if \(!\(await connectOriginAllowed\(tenantId, origin\)\)\) return/);
  assert.match(start, /jar\.set\("wa_signup", started\.state, \{ httpOnly: true, secure: true, sameSite: "lax"/);
  const finishRoute = code("src/app/api/integrations/whatsapp/finish/route.ts");
  assert.match(finishRoute, /const user = await requireTenantOwner\(\);/);
  assert.match(finishRoute, /const handoff = validHandoff\(await request\.json\(\)\.catch\(\(\) => null\)\);/);
  assert.match(finishRoute, /if \(!tenantId \|\| !handoff \|\| !cookieState \|\| cookieState !== handoff\.state\) \{/);
  assert.match(finishRoute, /action: "integration\.whatsapp_connected"/);
  // Only the popup is public; it connects nothing.
  const proxy = code("src/proxy.ts");
  const list = proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("];", proxy.indexOf("const PUBLIC_PATHS")));
  assert.match(list, /"\/connect\/whatsapp",/);
  assert.doesNotMatch(list, /"\/api\/integrations\/whatsapp/);
  assert.doesNotMatch(code("src/app/connect/whatsapp/page.tsx"), /connectWhatsAppNumber|putTenantCredential/);
});

test("the popup hands back only a real finish, to the exact origin that started it", () => {
  const popup = code("src/app/connect/whatsapp/WhatsAppSignupPopup.tsx");
  assert.match(popup, /if \(code && session\.current\) \{\s*window\.opener\?\.postMessage\(\{ type: SIGNUP_MESSAGE_TYPE, state, code, \.\.\.session\.current \}, returnOrigin\);/);
  assert.match(popup, /config_id: configId, response_type: "code", override_default_response_type: true, extras: \{ setup: \{\} \}/);
  const button = code("src/components/settings/WhatsAppConnectButton.tsx");
  assert.match(button, /const handoff = parseSignupHandoff\(event\.origin, platformOrigin, event\.data\);\s*if \(!handoff\) return;/);
  assert.match(button, /const popup = window\.open\("about:blank"/, "opened on the click, before any await");
  assert.ok(button.indexOf('window.open("about:blank"') < button.indexOf('await fetch("/api/integrations/whatsapp/start"'));
});

test("the opener policy is relaxed on exactly two pages; everything else stays same-origin", () => {
  const config = code("next.config.ts");
  assert.match(config, /\{ key: "Cross-Origin-Opener-Policy", value: "same-origin" \}/);
  assert.match(config, /source: "\/settings\/integrations",\s*headers: \[\{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" \}\],/);
  assert.match(config, /source: "\/connect\/whatsapp",\s*headers: \[\{ key: "Cross-Origin-Opener-Policy", value: "unsafe-none" \}\],/);
  assert.equal(config.match(/Cross-Origin-Opener-Policy/g)?.length, 3);
});

test("off until configured; a pasted setup (Denago's) is never disconnected by it", () => {
  const lib = code("src/lib/whatsappConnect.ts");
  assert.match(lib, /return appId && appSecret && configId \? \{ appId, appSecret, configId \} : null;/);
  assert.match(code("src/components/settings/WhatsAppConnectBox.tsx"), /if \(!app && !connected\) return null;/);
  // "Connected" = made by Connect WhatsApp (its account id recorded) — a pasted id + token is not.
  assert.match(lib, /return wabaId && number \? \{ wabaId, number, name, phoneNumberId \} : null;/);
  const disconnect = lib.slice(lib.indexOf("export async function disconnectWhatsApp"));
  assert.match(disconnect, /const connected = await connectedWhatsApp\(tenantId\);\s*if \(!connected\) return null;/);
  assert.doesNotMatch(disconnect, /\/deregister/, "the number stays registered — it's the business's");
  assert.match(code("src/app/(app)/settings/integrations/page.tsx"), /\{integration\.id === "whatsapp" && <WhatsAppConnectBox tenantId=\{tenantId\} \/>\}/);
});
