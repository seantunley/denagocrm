import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";

/*
 * Sean, 2026-11-27: "tenant fourbuy has no access to setup chatgpt and whatsapp
 * etc… why?" — then: "Each workspace has to have their own details. Change it."
 *
 * The AI (ChatGPT, Claude, which model), voice, Telegram and Maps rows were the
 * platform owner's alone, and a workspace had no way at all to make the API key
 * its website sends leads with. Every workspace owner now sets their own — and
 * only their own.
 */

Module.prototype.require = new Proxy(Module.prototype.require, {
  apply(target, self, args: [string]) {
    return args[0] === "server-only" ? {} : Reflect.apply(target, self, args);
  },
});
const { generateApiKey, hashApiKey, API_KEY_SCOPES } = createRequire(import.meta.url)("../src/lib/apiKeys.ts") as typeof import("../src/lib/apiKeys");

const read = (path: string) => readFileSync(path, "utf8");

test("a workspace key is unguessable, header-safe, recognisable — and only its hash is stored", () => {
  const keys = new Set(Array.from({ length: 200 }, () => generateApiKey()));
  assert.equal(keys.size, 200, "never the same twice");
  for (const key of keys) {
    assert.match(key, /^dcrm_[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url — safe in an X-Api-Key header");
    assert.notEqual(hashApiKey(key), key);
    assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  }
  // The same scopes the public routes ask for (authenticateIntakeKey callers).
  assert.deepEqual([...API_KEY_SCOPES], ["intake", "bookings", "service-lookup"]);
  for (const [route, scope] of [["src/app/api/intake/route.ts", "intake"], ["src/app/api/bookings/route.ts", "bookings"], ["src/app/api/service-lookup/route.ts", "service-lookup"]]) {
    assert.match(read(route), new RegExp(`authenticateIntakeKey\\(req\\.headers\\.get\\("x-api-key"\\), "${scope}"\\)`));
  }
});

test("every key query names the workspace — the table is read outside any tenant scope", () => {
  const lib = read("src/lib/apiKeys.ts");
  const own = lib.slice(lib.indexOf("// ── A workspace's own keys"));
  const statements = own.match(/basePrisma\.\$(?:queryRaw|executeRaw)<?[^`]*`[^`]*`/g) ?? [];
  assert.equal(statements.length, 3, "list, create, revoke");
  for (const statement of statements) {
    assert.match(statement, /"tenantId"|\$\{tenantId\}/, statement.slice(0, 80));
  }
  assert.match(own, /WHERE "tenantId" = \$\{tenantId\} AND "revokedAt" IS NULL/, "list: this workspace's live keys");
  assert.match(own, /VALUES \(\$\{id\}, \$\{tenantId\}, \$\{label\}, \$\{hashApiKey\(rawKey\)\}, \$\{prefix\}/, "create: stored as a hash, for this workspace");
  assert.match(own, /WHERE "id" = \$\{id\} AND "tenantId" = \$\{tenantId\} AND "revokedAt" IS NULL/, "revoke: only this workspace's, only once");
  assert.doesNotMatch(own, /\$\{rawKey\}/, "the raw key is never written");
});

test("only the workspace's owner makes or revokes its keys, for the workspace they are in", () => {
  const actions = read("src/app/actions/apiKeys.ts");
  for (const name of ["createApiKey", "revokeApiKey"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body, /const user = await requireTenantOwner\(\);/, name);
    assert.ok(body.indexOf("requireTenantOwner()") < body.indexOf("actingTenantId()"), `${name}: who, then where`);
    assert.match(body, /await logAudit\(/, `${name} is audited`);
  }
  assert.doesNotMatch(actions, /requireOwner\(/, "a workspace surface, not the platform's");
  const panel = read("src/components/settings/ApiKeysPanel.tsx");
  assert.match(panel, /It is shown this once/);
  assert.match(panel, /\{key\.prefix\}…/, "afterwards only its first characters");
});

test("every workspace owner gets the AI, voice, Telegram, Maps and website-key rows — their own values", () => {
  const rows = read("src/components/settings/WorkspaceIntegrationRows.tsx");
  // Only the platform's webhook / Meta app row is held back.
  assert.match(rows, /return rows\.filter\(\(row\) => row\.id !== "webhooks" \|\| platformSetup\);/);
  for (const id of ["telegram", "google-maps", "ai-choice", "claude", "chatgpt", "elevenlabs", "intake"]) {
    assert.match(rows, new RegExp(`id: "${id}",`), id);
  }
  // Their actions take the workspace's owner and write the acting workspace's own row.
  for (const [file, fns] of [
    ["src/app/actions/settings.ts", ["saveSetting", "regenerateSetting", "revealSecret", "clearSecret"]],
    ["src/app/actions/codex.ts", ["startChatGptLogin", "pollChatGptLogin", "disconnectChatGpt", "testChatGpt"]],
    ["src/app/actions/aiModel.ts", ["saveAiModel"]],
    ["src/app/actions/bot.ts", ["connectTelegram", "disconnectTelegram"]],
    ["src/app/actions/voicePreview.ts", ["previewVoice"]],
  ] as const) {
    const source = read(file);
    for (const fn of fns) {
      const body = source.slice(source.indexOf(`export async function ${fn}`), source.indexOf(`export async function ${fn}`) + 400);
      assert.match(body, /requireTenantOwner\(\)/, `${file} ${fn}`);
    }
  }
  // The website-key row is the workspace's own keys — not the old single setting the public routes refuse under enforcement.
  assert.match(rows, /body: <ApiKeysPanel keys=\{apiKeys\} endpoint=\{`\$\{PLATFORM_URL\}\/api\/intake`\} \/>/);
  assert.doesNotMatch(rows, /INTAKE_API_KEY"/);
  assert.match(read("src/lib/apiKeys.ts"), /if \(tenantEnforcing\(\)\) return null; \/\/ enforcement: per-tenant keys only/);
});

test("a plan that supplies the AI says so — and the key it supplies is never shown", () => {
  const rows = read("src/components/settings/WorkspaceIntegrationRows.tsx");
  assert.match(rows, /const claudeSupplied = !setting\("ANTHROPIC_API_KEY"\) && platformSupplies;/);
  assert.match(rows, /Boolean\(setting\("ANTHROPIC_API_KEY"\)\) \|\| claudeSupplied\);/, "counted as aiProvider() counts it");
  assert.match(rows, /Supplied with your plan — save your own key to use your own Anthropic account/);
  assert.doesNotMatch(rows, /getProviderKey/);
  const page = read("src/app/(app)/settings/integrations/page.tsx");
  assert.match(page, /basePrisma\.tenant\.findFirst\(\{ where: \{ id: tenantId, platformAi: true, active: true \}, select: \{ id: true \} \}\)/);
  assert.match(page, /const planSupplies = tenantId && tenantId !== DEFAULT_TENANT_ID/, "the founding workspace's keys are its own, never 'supplied'");
});
