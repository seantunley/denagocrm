import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INTEGRATION_GROUPS,
  INTEGRATION_META,
  STATE_LABEL,
  checkedAgo,
  connectedTo,
  groupIntegrationRows,
  integrationAction,
  workspaceIntegrationState,
  workspaceValueUse,
} from "../src/lib/integrationsCatalogue";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";

/** Settings → Integrations, rebuilt from settings-screens-improvements.md (2026-11-12). */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("one status vocabulary: Connected, Saved not checked, Using shared setup, Not set up — plus the two that need attention", () => {
  assert.deepEqual(Object.values(STATE_LABEL), ["Connected", "Saved, not checked", "Using shared setup", "Not set up", "Reconnect needed", "Half set up"]);
  const s = (input: Partial<Parameters<typeof workspaceIntegrationState>[0]>) =>
    workspaceIntegrationState({ needsReauth: false, verified: false, ownStatus: "default", sharedInUse: false, ...input });
  assert.equal(s({ needsReauth: true, verified: true, ownStatus: "active" }), "reconnect", "broken beats last-seen-working");
  assert.equal(s({ verified: true, ownStatus: "active" }), "connected");
  assert.equal(s({ verified: true, sharedInUse: true }), "connected", "the shared values, proven by a send");
  assert.equal(s({ ownStatus: "incomplete", sharedInUse: true }), "incomplete", "half its own values: rises to attention");
  assert.equal(s({ sharedInUse: true }), "shared");
  assert.equal(s({}), "not-set-up");
});

test("review of #1083: credentials typed in but never proven are NOT Connected", () => {
  const s = (input: Partial<Parameters<typeof workspaceIntegrationState>[0]>) =>
    workspaceIntegrationState({ needsReauth: false, verified: false, ownStatus: "default", sharedInUse: false, ...input });
  assert.equal(s({ ownStatus: "active" }), "unverified", "SMTP/WhatsApp saved by hand, never tested");
  assert.equal(integrationAction("unverified"), "Check", "with a clear next step");
  assert.equal(s({ verified: true }), "not-set-up", "an old verdict with no values in use proves nothing");
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.match(page, /Saved but never tested — open it and press Test connection/);
  assert.match(page, /guided && state !== "not-set-up" && state !== "incomplete" && <IntegrationTestButton/, "the Test button is there for it");
});

test("review of #1083: Xero is judged by its own connected organisation — never 'Using shared setup'", () => {
  const xero = (hasOverride: Record<string, boolean>, verified: boolean) => {
    const use = workspaceValueUse({ integrationId: "xero", overrideStatus: "default", requiredKeys: [], hasOverride, effectiveSet: {} });
    return workspaceIntegrationState({ needsReauth: false, verified, ...use });
  };
  assert.equal(xero({}, false), "not-set-up", "no organisation connected");
  assert.equal(xero({}, true), "not-set-up", "a leftover verdict without an organisation is still disconnected");
  assert.equal(xero({ XERO_TENANT_ID: true }, true), "connected", "organisation connected and signed in");
  assert.equal(xero({ XERO_TENANT_ID: true }, false), "unverified");
  assert.equal(
    workspaceIntegrationState({ needsReauth: true, verified: true, ...workspaceValueUse({ integrationId: "xero", overrideStatus: "default", requiredKeys: [], hasOverride: { XERO_TENANT_ID: true }, effectiveSet: {} }) }),
    "reconnect",
  );
  // The root cause: every() over an empty list is true. No required values means nothing shared.
  assert.equal(workspaceValueUse({ integrationId: "other", overrideStatus: "default", requiredKeys: [], hasOverride: {}, effectiveSet: {} }).sharedInUse, false);
  assert.equal(workspaceValueUse({ integrationId: "smtp", overrideStatus: "default", requiredKeys: ["SMTP_HOST"], hasOverride: {}, effectiveSet: { SMTP_HOST: true } }).sharedInUse, true);
  assert.equal(workspaceValueUse({ integrationId: "smtp", overrideStatus: "active", requiredKeys: ["SMTP_HOST"], hasOverride: {}, effectiveSet: { SMTP_HOST: true } }).sharedInUse, false);
});

test("one button that matches the state", () => {
  assert.equal(integrationAction("not-set-up"), "Connect");
  assert.equal(integrationAction("connected"), "Manage");
  assert.equal(integrationAction("shared"), "Manage");
  assert.equal(integrationAction("reconnect"), "Fix");
  assert.equal(integrationAction("incomplete"), "Fix");
});

test("grouped by purpose, anything broken or half set up first, and nothing ever dropped", () => {
  assert.deepEqual(INTEGRATION_GROUPS.map((g) => g.label), ["Needs attention", "Messaging channels", "Email", "Accounting", "AI", "Other services"]);
  const grouped = groupIntegrationRows([
    { id: "smtp", state: "connected" as const },
    { id: "whatsapp", state: "reconnect" as const },
    { id: "xero", state: "connected" as const },
    { id: "telegram", state: "incomplete" as const },
    { id: "something-new", state: "not-set-up" as const },
  ]);
  assert.deepEqual(grouped.map((g) => [g.group.key, g.rows.map((r) => r.id)]), [
    ["attention", ["whatsapp", "telegram"]],
    ["email", ["smtp"]],
    ["accounting", ["xero"]],
    ["other", ["something-new"]],
  ]);
  // Every per-workspace integration and every platform row has a purpose and a mark.
  for (const id of [...TENANT_CREDENTIAL_INTEGRATIONS.map((i) => i.id), "telegram", "google-maps", "ai-choice", "claude", "chatgpt", "elevenlabs", "intake", "webhooks"]) {
    assert.ok(INTEGRATION_META[id]?.purpose, `${id} has a one-line purpose`);
    assert.ok(INTEGRATION_META[id]?.mark.text, `${id} has a mark`);
  }
});

test("each row says what it's connected to and when it was last checked — never a secret", () => {
  assert.equal(connectedTo("smtp", { SMTP_FROM: "sales@denagocpt.co.za" }), "Sends as sales@denagocpt.co.za");
  assert.equal(connectedTo("xero", { XERO_ORG_NAME: "Denago Cape Town" }), "Organisation: Denago Cape Town");
  assert.equal(connectedTo("x", { X_USERNAME: "@denago" }), "@denago");
  assert.equal(connectedTo("sms", {}), null);
  const now = new Date("2026-11-12T12:00:00Z");
  assert.equal(checkedAgo(new Date("2026-11-12T11:55:00Z"), now), "5 minutes ago");
  assert.equal(checkedAgo(new Date("2026-11-12T09:00:00Z"), now), "3 hours ago");
  // The page reads them from effectiveShown, which the page fills with non-secret values only.
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.match(page, /state === "connected" \|\| state === "shared" \? connectedTo\(integration\.id, effectiveShown\) : null,/, "only while in use");
  assert.match(page, /if \(isSecretSettingKey\(key\)\) continue;/);
});

test("the screen: headings, marks, purpose and detail lines, a matching button, a test, a plain intro", () => {
  const page = src("src/app/(app)/settings/integrations/page.tsx");
  assert.match(page, /const grouped = groupIntegrationRows\(\[\.\.\.workspaceRows, \.\.\.platformRows\]\);/);
  assert.match(page, /action=\{integrationAction\(row\.state\)\}/);
  assert.match(page, /mark=\{meta\?\.mark\}\s*purpose=\{meta\?\.purpose\}\s*detail=\{row\.detail\}/);
  assert.match(page, /<summary className="cursor-pointer select-none text-foreground">How this works<\/summary>/);
  assert.doesNotMatch(page, /Platform default|platform default|Not configured/, "the developer words are gone");
  // A re-test of what is saved, on the integrations that have one, once they're in use.
  assert.match(page, /\{guided && state !== "not-set-up" && state !== "incomplete" && <IntegrationTestButton integrationId=\{integration\.id\} \/>\}/);
  assert.match(src("src/components/settings/IntegrationTestButton.tsx"), /retestIntegration\(integrationId\)/);
});
