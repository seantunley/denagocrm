import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveIntegrationBundle } from "../src/lib/settings";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { TENANT_CREDENTIAL_INTEGRATIONS, integrationOverrideStatus } from "../src/lib/tenantCredentialFields";

// Re-review of #742: Settings → Integrations labelled X by the all-or-nothing set
// rule, but X's OAuth and runtime read each field on its own — so a half-entered
// override could sign with this workspace's client id and the platform's secret
// while the page said the saved value was "not in use".
//
// X now has two layers, and the page and runtime share ONE resolver:
//  - the X APP (client id, client secret, webhook secret) is a set;
//  - the connected account's sign-in tokens and Grok settings are `independent`
//    — the OAuth callback writes them per workspace, whichever app it ran through.

const GLOBAL: Record<string, string> = {
  X_CLIENT_ID: "platform-client",
  X_CLIENT_SECRET: "platform-secret",
  X_WEBHOOK_SECRET: "platform-webhook",
  X_ACCESS_TOKEN: "platform-token",
};
const deps = (own: Record<string, string>) => ({
  lookupOverrides: async () => new Map(Object.entries(own)),
  getGlobal: async (key: string) => GLOBAL[key] ?? null,
});
const OTHER = "tenant_other";

test("a half-entered X app never pairs this workspace's client id with the platform's secret", async () => {
  const x = await resolveIntegrationBundle(DEFAULT_TENANT_ID, "x", deps({ X_CLIENT_ID: "own-client" }));
  assert.equal(x?.X_CLIENT_ID, "platform-client", "the app set stays whole until every app field is the workspace's own");
  assert.equal(x?.X_CLIENT_SECRET, "platform-secret");
});

test("a complete own X app is used as a whole", async () => {
  const x = await resolveIntegrationBundle(DEFAULT_TENANT_ID, "x", deps({
    X_CLIENT_ID: "own-client", X_CLIENT_SECRET: "own-secret", X_WEBHOOK_SECRET: "own-webhook",
  }));
  assert.deepEqual([x?.X_CLIENT_ID, x?.X_CLIENT_SECRET, x?.X_WEBHOOK_SECRET], ["own-client", "own-secret", "own-webhook"]);
});

test("the workspace's sign-in tokens are used even while the app comes from settings", async () => {
  // Denago today: the X app is in settings, and OAuth saved the account's tokens
  // as the workspace's own. The set rule alone would have ignored those tokens.
  const x = await resolveIntegrationBundle(DEFAULT_TENANT_ID, "x", deps({ X_ACCESS_TOKEN: "own-token", X_ACCOUNT_ID: "42" }));
  assert.equal(x?.X_ACCESS_TOKEN, "own-token");
  assert.equal(x?.X_ACCOUNT_ID, "42");
  assert.equal(x?.X_CLIENT_ID, "platform-client");
  // …and they do not make the app set "incomplete" on the page.
  const integration = TENANT_CREDENTIAL_INTEGRATIONS.find((entry) => entry.id === "x")!;
  assert.equal(integrationOverrideStatus(integration, { X_ACCESS_TOKEN: true, X_ACCOUNT_ID: true }), "default");
  assert.equal(integrationOverrideStatus(integration, { X_CLIENT_ID: true }), "incomplete");
});

test("another workspace gets nothing from the platform, independent fields included", async () => {
  assert.equal(await resolveIntegrationBundle(OTHER, "x", deps({ X_ACCESS_TOKEN: "own-token" })), null);
  const x = await resolveIntegrationBundle(OTHER, "x", deps({
    X_CLIENT_ID: "c", X_CLIENT_SECRET: "s", X_WEBHOOK_SECRET: "w",
  }));
  assert.equal(x?.X_ACCESS_TOKEN, null, "no platform token leaks to another workspace");
});

test("other integrations keep the plain set rule", async () => {
  const smtp = await resolveIntegrationBundle(DEFAULT_TENANT_ID, "smtp", {
    lookupOverrides: async () => new Map([["SMTP_HOST", "own-host"]]),
    getGlobal: async (key) => (key === "SMTP_HOST" ? "platform-host" : null),
  });
  assert.equal(smtp?.SMTP_HOST, "platform-host");
  for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
    if (integration.id !== "x") assert.ok(integration.fields.every((field) => !field.independent), `${integration.id} has no independent fields`);
  }
});

test("no X credential is read field by field anywhere", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  for (const file of [
    "src/lib/x.ts",
    "src/lib/messenger.ts",
    "src/app/actions/x.ts",
    "src/app/api/webhooks/x/route.ts",
    "src/app/api/integrations/x/connect/route.ts",
    "src/app/api/integrations/x/callback/route.ts",
  ]) {
    assert.doesNotMatch(read(file), /resolveTenantCredential\([^)]*"(X_|XAI_)/, `${file} reads an X credential on its own`);
  }
});
