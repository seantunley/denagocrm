import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const code = (path: string) => readFileSync(path, "utf8");

test("Sean, 2026-11-02 — a live flow can be taken offline: unpublished, and the built-in default does not stand in", () => {
  const publishing = code("src/lib/flowPublishing.ts");
  const resolver = publishing.slice(publishing.indexOf("export async function resolveFlowSnapshot"), publishing.indexOf("export async function takeFlowOffline"));
  // Published before, nothing published now → null, checked just before the built-in default.
  assert.match(resolver, /if \(await everPublishedOn\(tenantId, [^)]*\)\) return null;\s*return \{ flow: DEFAULT_FLOW/);
  // Review of #956: a channel whose OWN flow was taken offline answers nobody BEFORE the fallback to WhatsApp's flow.
  const ownOff = resolver.indexOf('if (!own && channel !== "whatsapp" && (await everPublishedOn(tenantId, [channel]))) return null;');
  assert.ok(ownOff > 0 && ownOff < resolver.indexOf('channel: "whatsapp" } })'), "checked before the WhatsApp fallback");
  // Routes are resolved first, so a QR code still answers.
  assert.ok(resolver.indexOf("resolveRoutedFlowVersion") < ownOff);
  const offline = publishing.slice(publishing.indexOf("export async function takeFlowOffline"));
  // One transaction (review of #956), inactive first, so the legacy fallback can never pick up the unpublished draft.
  assert.match(offline, /await withTenantWrite\(async \(tx\) => \{\s*await tx\.botFlow\.updateMany\([^;]*data: \{ active: false \} \}\);\s*await tx\.botFlowPublication\.deleteMany/);
  assert.match(offline, /flowTenantWhere\(tenantId\)/);
});

test("no flow → no reply on every channel: WhatsApp, and Messenger/Instagram/Telegram", () => {
  assert.match(code("src/lib/flowRun.ts"), /if \(!snapshot\) return true;/);
  assert.match(code("src/lib/flowSession.ts"), /if \(!snapshot\) return \{ messages: \[\], done: true, suppressed: true \};/);
});

test("the owner's 'Take offline' asks first, says what follows, and is audited", () => {
  const page = code("src/app/(app)/bot-builder/page.tsx");
  assert.match(page, /\{f\.active && \(\s*<ConfirmActionDialog[\s\S]*?Take offline[\s\S]*?onConfirm=\{setFlowOffline\.bind\(null, f\.id\)\}/);
  const action = code("src/app/actions/flow.ts");
  const fn = action.slice(action.indexOf("export async function setFlowOffline"), action.indexOf("export async function duplicateFlow"));
  assert.match(fn, /requireTenantOwner\(\)/);
  assert.match(fn, /action: "bot\.flow_offline"/);
});
