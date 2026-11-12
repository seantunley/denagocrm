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
} from "../src/lib/integrationsCatalogue";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";

/** Settings → Integrations, rebuilt from settings-screens-improvements.md (2026-11-12). */
const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

test("one status vocabulary: Connected, Using shared setup, Not set up — plus the two that need attention", () => {
  assert.deepEqual(Object.values(STATE_LABEL), ["Connected", "Using shared setup", "Not set up", "Reconnect needed", "Half set up"]);
  const s = (input: Partial<Parameters<typeof workspaceIntegrationState>[0]>) =>
    workspaceIntegrationState({ needsReauth: false, verified: false, ownStatus: "default", sharedInUse: false, ...input });
  assert.equal(s({ needsReauth: true, verified: true }), "reconnect", "broken beats last-seen-working");
  assert.equal(s({ verified: true }), "connected");
  assert.equal(s({ ownStatus: "active" }), "connected");
  assert.equal(s({ ownStatus: "incomplete", sharedInUse: true }), "incomplete", "half its own values: rises to attention");
  assert.equal(s({ sharedInUse: true }), "shared");
  assert.equal(s({}), "not-set-up");
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
  assert.match(page, /connectedTo\(integration\.id, effectiveShown\)/);
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
