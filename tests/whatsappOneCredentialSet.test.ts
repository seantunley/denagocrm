import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// WhatsApp credentials are one SET: a phone number id only works with the token
// of the same Meta account. The sender resolved them as a set
// (resolveIntegrationBundle: a workspace's own values count only once every
// required one is set) but inbound routing and media downloads read them field
// by field. With a half-entered workspace override, routing registered the
// workspace's own phone number id while sends still went out from the settings
// number — replies to the number customers saw could be routed nowhere.
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("no WhatsApp credential is resolved field by field anywhere", () => {
  for (const file of ["src/lib/channelRegistration.ts", "src/lib/whatsapp.ts"]) {
    assert.doesNotMatch(src(file), /resolveTenantCredential\([^)]*"WA_/, `${file} reads a WhatsApp credential on its own`);
  }
});

test("routing, sending and media resolve the same set", () => {
  const registration = src("src/lib/channelRegistration.ts");
  assert.match(registration, /const whatsappBundle = await resolveIntegrationBundle\(tenantId, "whatsapp"\);/);
  assert.match(registration, /const phoneNumberId = whatsappBundle\?\.WA_PHONE_NUMBER_ID \?\? null;/);
  assert.match(registration, /const accessToken = whatsappBundle\?\.WA_ACCESS_TOKEN \?\? null;/);

  const whatsapp = src("src/lib/whatsapp.ts");
  const sender = whatsapp.slice(whatsapp.indexOf("async function waCredentials("));
  assert.match(sender.slice(0, 400), /resolveIntegrationBundleForTenant\(ambientTenantId\(\), "whatsapp"\)/);
  const media = whatsapp.slice(whatsapp.indexOf("export async function fetchWhatsAppMedia("));
  assert.match(media.slice(0, 900), /resolveIntegrationBundleForTenant\(ambientTenantId\(\), "whatsapp"\)/);
  assert.match(media.slice(0, 900), /tenantId: bundle\.tenantId,/);
});
