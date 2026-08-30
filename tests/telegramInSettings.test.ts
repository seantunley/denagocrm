import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { TENANT_CREDENTIAL_INTEGRATIONS, isKnownTenantCredentialKey } from "../src/lib/tenantCredentialFields";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * Source with comments stripped — the repo's usual `shipped()` convention.
 *
 * Needed here in particular: the chatbot page carries a comment explaining why
 * Telegram is NOT on it, and a naive scan would match that comment and report
 * the very thing it documents as still present. JSX `{/* … *\/}` blocks are
 * ordinary block comments once the braces are gone.
 */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SETTINGS = "src/app/(app)/settings/page.tsx";
const CHATBOT = "src/app/(app)/chatbot/page.tsx";

/**
 * Telegram is a customer channel and belongs on the screen that lists customer
 * channels.
 *
 * It used to appear ONLY in the chatbot page's sidebar, so Settings →
 * Integrations listed X, Meta, WhatsApp, Google, SMS, AI and ElevenLabs — every
 * channel except this one. Somebody looking for it in the obvious place
 * concluded it did not exist.
 */

test("Telegram is on the Integrations screen with the other channels", () => {
  const source = read(SETTINGS);
  assert.match(source, /title="Telegram"/, "Settings → Integrations must list Telegram");
});

test("connecting from Settings REGISTERS the webhook, rather than just storing a token", () => {
  // This is the whole difference. `connectTelegram` stores the token, mints a
  // per-tenant webhook secret, calls Telegram's setWebhook and records whether
  // that succeeded. A plain `saveSetting` would store a credential and leave the
  // channel receiving nothing — which is precisely the failure mode that cost
  // WhatsApp eighteen days of dropped messages.
  const source = read(SETTINGS);
  assert.match(source, /action=\{connectTelegram\}/);
  assert.match(source, /action=\{disconnectTelegram\}/);
  assert.doesNotMatch(
    source,
    /name="key" value="TELEGRAM_BOT_TOKEN"/,
    "a plain settings save cannot register the webhook, so it must not be offered",
  );
});

test("the badge distinguishes 'token stored' from 'actually receiving'", () => {
  // BOT_TG_ENABLED records whether setWebhook succeeded. A token with a failed
  // registration must not read as Connected.
  const source = read(SETTINGS);
  assert.match(source, /setting\("BOT_TG_ENABLED"\) === "true"/);
  assert.match(source, /webhook not registered/i);
});

test("A CHANNEL IS CONFIGURED IN ONE PLACE — Telegram is not on the chatbot page at all", () => {
  /*
   * The rule, stated plainly: channel setup lives in Settings → Integrations,
   * like WhatsApp, Meta and X. Nothing about connecting Telegram — not a form,
   * not a status badge, not a shortcut — belongs anywhere else.
   *
   * Telegram was the only channel with a second home, and was correspondingly
   * missing from the screen that lists customer channels, so people looking in
   * the obvious place concluded it was unsupported.
   *
   * The chatbot page keeps BOT BEHAVIOUR: the master switch, the guided-flow
   * toggle, and the Messenger/Instagram DM toggle. Those are about how the bot
   * acts, not about where a channel connects.
   */
  const source = shipped(CHATBOT);
  assert.doesNotMatch(source, /Telegram/, "channel setup belongs only in Settings → Integrations");
  assert.doesNotMatch(source, /telegramStatus|connectTelegram|disconnectTelegram/);
});

test("the override page no longer offers a Telegram token it cannot make work", () => {
  /*
   * An override stores TELEGRAM_BOT_TOKEN in TenantIntegrationCredential, but
   * `resolveTelegramTenant` matches an inbound update by scanning
   * TELEGRAM_WEBHOOK_SECRET rows in AppSetting. A token saved that way had no
   * secret to be found by and no webhook registered against it, so Telegram had
   * nowhere to deliver — the owner got a stored credential and silence.
   */
  const ids = TENANT_CREDENTIAL_INTEGRATIONS.map((integration) => integration.id);
  assert.ok(!ids.includes("telegram"), "the override entry could never receive a message");
  assert.equal(
    isKnownTenantCredentialKey("TELEGRAM_BOT_TOKEN"),
    false,
    "and the action must refuse the key, not just hide the field",
  );
});

test("Telegram's tenancy still works, because the secret is what identifies the workspace", () => {
  // The reason removing the override is safe rather than a regression:
  // `putSetting` already scopes to the acting workspace, so `connectTelegram`
  // writes a per-tenant token AND a per-tenant secret, and the resolver matches
  // on that secret across active tenants.
  const resolver = read("src/lib/telegramTenant.ts");
  assert.match(resolver, /TELEGRAM_WEBHOOK_SECRET/);
  assert.match(resolver, /s\."tenantId"/, "the secret lookup is per tenant");

  const action = read("src/app/actions/bot.ts");
  assert.match(action, /putSetting\("TELEGRAM_BOT_TOKEN", token\)/);
  assert.match(action, /putSetting\("TELEGRAM_WEBHOOK_SECRET", secret\)/);
  assert.match(action, /setTelegramWebhook\(/);
});
