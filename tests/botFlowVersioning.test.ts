import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("one immutable publication exists per tenant and channel", () => {
  const schema = src("prisma/bot-flow-publishing.prisma");
  assert.match(schema, /model BotFlowVersion/);
  assert.match(schema, /definition\s+String/);
  assert.match(schema, /@@unique\(\[tenantId, flowId, version\]\)/);
  assert.match(schema, /model BotFlowPublication/);
  assert.match(schema, /@@unique\(\[tenantId, channel\]\)/);

  const migration = src("prisma/migrations/20260809150000_bot_flow_publications/migration.sql");
  assert.match(migration, /BotFlowPublication_tenant_channel_key/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /BotFlowVersion_flowId_fkey[\s\S]*ON DELETE RESTRICT/);
});

test("publishing snapshots the draft and switches live state in one tenant transaction", () => {
  const code = src("src/lib/flowPublishing.ts");
  assert.match(code, /withTenantWrite\(async \(tx, tenantId\)/);
  assert.match(code, /tx\.botFlowVersion\.create/);
  assert.match(code, /definition: flow\.definition/);
  assert.match(code, /tx\.botFlowPublication\.upsert/);
  assert.match(code, /tenantId_channel: \{ tenantId, channel: flow\.channel \}/);
});

test("a missing pinned version fails closed instead of falling through to the current publication", () => {
  const code = src("src/lib/flowPublishing.ts");
  const pinAt = code.indexOf("if (pinnedVersionId)");
  const throwAt = code.indexOf("throw new PinnedFlowVersionUnavailableError", pinAt);
  const publicationAt = code.indexOf("const publication", pinAt);
  assert.ok(pinAt >= 0 && throwAt > pinAt && publicationAt > throwAt);
  assert.match(code, /if \(!pinned \|\| !flow\) throw new PinnedFlowVersionUnavailableError\(pinnedVersionId\)/);
});

test("published flows cannot be deleted while immutable versions may still be session-pinned", () => {
  const actions = src("src/app/actions/flow.ts");
  assert.match(actions, /prisma\.botFlowVersion\.findFirst\(\{ where: \{ flowId: id \}/);
  assert.match(actions, /if \(!flow \|\| flow\.active \|\| publishedVersion\) return/);
});

test("shared channel sessions persist and resolve a pinned flow version", () => {
  const code = src("src/lib/flowSession.ts");
  assert.match(code, /flowVersionId: p\.fv \?\? null/);
  assert.match(code, /fv: state\.flowVersionId/);
  assert.match(code, /resolveFlowSnapshot\(channel, restart \? null : state\.flowVersionId\)/);
});

test("WhatsApp sessions persist and resolve their publication pin", () => {
  const code = src("src/lib/flowRun.ts");
  assert.match(code, /FLOW_VERSION_VAR = "__flow_version"/);
  assert.match(code, /existing\?\.flowVersionId \?\? null/);
  assert.match(code, /storedVars\(result\.session\.vars, snapshot\.versionId\)/);
  assert.match(code, /upsertBotSessionTx\(tx, tenantId/);
});

test("saving a flow is a draft operation and publishing is explicit", () => {
  const actions = src("src/app/actions/flow.ts");
  assert.match(actions, /Chatbot flow draft updated/);
  assert.match(actions, /publishFlowSnapshot\(id, owner\.id\)/);

  const editor = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(editor, /You are editing a draft/);
  assert.match(editor, /Save keeps these changes private/);
});
