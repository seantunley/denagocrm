import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseMetaSignedRequest } from "../src/lib/metaSignedRequest";
import { PLATFORM, dataDeletionStatusUrl } from "../src/lib/platformLegal";

/**
 * Meta App Review needs a public privacy policy, terms and data-deletion page, plus a data-deletion callback, in the
 * platform's own name (Sean, 2026-11-21: "Honeycomb 360", "crm.honeycombventures.co.za").
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const SECRET = "test-app-secret";
function signed(payload: object, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

test("a signed request Meta really sent is read; anything forged or garbled is refused", () => {
  assert.deepEqual(parseMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "1234567890" }), SECRET), { userId: "1234567890" });
  // Signed with another app's secret.
  assert.equal(parseMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "1" }, "other"), SECRET), null);
  // Payload changed after signing.
  const [sig] = signed({ algorithm: "HMAC-SHA256", user_id: "1" }).split(".");
  const swapped = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "2" })).toString("base64url");
  assert.equal(parseMetaSignedRequest(`${sig}.${swapped}`, SECRET), null);
  // Wrong algorithm, no user, a non-numeric user, junk.
  assert.equal(parseMetaSignedRequest(signed({ algorithm: "none", user_id: "1" }), SECRET), null);
  assert.equal(parseMetaSignedRequest(signed({ algorithm: "HMAC-SHA256" }), SECRET), null);
  assert.equal(parseMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "1 OR 1=1" }), SECRET), null);
  for (const junk of ["", "abc", "a.b.c", "."]) assert.equal(parseMetaSignedRequest(junk, SECRET), null, junk);
  assert.equal(parseMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "1" }), ""), null, "no secret configured");
});

test("the callback acts only on a verified request, with the platform app's secret, and answers Meta's format", () => {
  const route = code("src/app/api/webhooks/meta/data-deletion/route.ts");
  assert.match(route, /const request = parseMetaSignedRequest\(signed, secret\);\s*if \(!request\) return NextResponse\.json\(\{ error: "Invalid signed request" \}, \{ status: 400 \}\);/);
  assert.match(route, /return NextResponse\.json\(\{ url: dataDeletionStatusUrl\(code\), confirmation_code: code \}\);/);
  assert.match(code("src/lib/metaDataDeletion.ts"), /getSetting\("META_APP_SECRET"\)/);
  assert.equal(dataDeletionStatusUrl("abc_123"), `https://${PLATFORM.domain}/legal/data-deletion?code=abc_123`);
});

test("deletion removes every connection that person made, each in its own workspace, and audits it there", () => {
  const lib = code("src/lib/metaDataDeletion.ts");
  // Found by the person Meta names — the key Connect Facebook records — and nothing else.
  assert.match(lib, /where: \{ key: CONNECTED\.byUser, value: metaUserId \}, select: \{ tenantId: true \}/);
  assert.match(lib, /await runInTenantScope\(\{ tenantId, system: false \}, async \(\) => \{\s*const name = await disconnectMetaPage\(tenantId\);\s*await logAudit\(/);
  // The status page answers only for a well-formed code, and only "when".
  assert.match(lib, /if \(!\/\^\[A-Za-z0-9_-\]\{8,24\}\$\/\.test\(code\)\) return null;/);
  assert.match(code("src/lib/metaConnect.ts"), /\[CONNECTED\.byUser\]: pending\.metaUserId,/, "Connect Facebook records who connected");
});

test("Connect Facebook signs in through the platform's own address; the CRM's base address is untouched", () => {
  // Sean, 2026-11-21: "platform address yes (do not affect Denago yet)".
  const lib = code("src/lib/metaConnect.ts");
  assert.match(lib, /export function metaCallbackUrl\(\): string \{\s*return `\$\{PLATFORM_URL\}\/api\/integrations\/meta\/callback`;/);
  assert.match(lib, /if \(url\.origin === new URL\(appBaseUrl\(\)\)\.origin \|\| url\.origin === PLATFORM_URL\) return true;/);
  assert.match(code("src/lib/campaigns.ts"), /process\.env\.NEXT_PUBLIC_APP_URL \|\| "https:\/\/crm\.denagocpt\.co\.za"/, "the base address is unchanged");
  // Public replies to Page comments (Sean: "Public replies: Yes").
  assert.match(lib, /"pages_manage_engagement",/);
  assert.doesNotMatch(code("src/lib/messenger.ts"), /Denago CRM app/, "staff of any workspace read this message");
});

test("the pages are public, in the platform's name, and say so plainly while company details are missing", () => {
  const proxy = code("src/proxy.ts");
  const list = proxy.slice(proxy.indexOf("const PUBLIC_PATHS"), proxy.indexOf("];", proxy.indexOf("const PUBLIC_PATHS")));
  assert.match(list, /"\/legal",/);
  for (const page of ["privacy", "terms", "data-deletion"]) {
    const source = code(`src/app/legal/${page}/page.tsx`);
    assert.match(source, /<LegalShell title=/, page);
    assert.doesNotMatch(source, /Denago/i, `${page}: the platform's page, never a workspace's name`);
  }
  assert.equal(PLATFORM.name, "Honeycomb 360");
  assert.equal(PLATFORM.domain, "crm.honeycombventures.co.za");
  assert.equal(PLATFORM.companyName, "Honeycomb Ventures (Pty) Ltd");
  assert.equal(PLATFORM.registrationNumber, "2025/378969/07");
  assert.equal(PLATFORM.privacyEmail, "privacy@honeycombventures.co.za");
  assert.match(code("src/app/legal/LegalShell.tsx"), /\{!complete && \(/);
});
