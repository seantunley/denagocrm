import { SaveForm, SaveButton } from "@/components/SaveForm";
import SecretReveal from "@/components/SecretReveal";
import ClearSecret from "@/components/ClearSecret";
import ChatGptConnect from "@/components/settings/ChatGptConnect";
import { SettingsIntegrationRow as Row } from "@/components/settings-workspace";
import { saveSetting, regenerateSetting } from "@/app/actions/settings";
import { connectTelegram, disconnectTelegram } from "@/app/actions/bot";
import { getSetting } from "@/lib/settings";
import { codexStatus, type CodexStatus } from "@/lib/codex";

/** The workspace settings these rows read. Never per-tenant-credential keys — those are the page's own forms. */
const KEYS = [
  "META_VERIFY_TOKEN",
  "META_APP_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "BOT_TG_ENABLED",
  "GOOGLE_MAPS_BROWSER_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_AUTO_RESEARCH",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "WHATSAPP_VOICE_REPLIES",
  "INTAKE_API_KEY",
] as const;

/**
 * The platform owner's integration rows on Settings → Integrations (batch 6,
 * one Integrations page). These used to be the rest of the old Settings →
 * Integrations tab: webhook endpoints, Telegram, Maps, the AI and voice keys and
 * the intake API. They are `AppSetting` values written by owner-only actions
 * (saveSetting, connectTelegram…), so the page renders this only for a platform
 * owner — exactly who could see the old tab.
 *
 * The credentials that also have a per-workspace override (X, WhatsApp, Meta's
 * page token, SMTP, IMAP, BulkSMS, Google reviews) are NOT here: the page's own
 * per-integration forms are the one place to edit them.
 */
export default async function WorkspaceIntegrationRows({ xAccountId }: { xAccountId: string | null }) {
  const values = new Map(await Promise.all(KEYS.map(async (key) => [key, (await getSetting(key)) ?? ""] as const)));
  const setting = (key: (typeof KEYS)[number]) => values.get(key) ?? "";
  // A read that fails must not take the page down with it.
  const chatGpt: CodexStatus = await codexStatus().catch((): CodexStatus => ({ state: "disconnected" }));

  return (
    <>
      <Row title="Webhooks (X, Meta, WhatsApp)" status={<span className="badge bg-muted text-muted-foreground">Platform</span>} action="View">
        <p className="text-xs text-muted-foreground mb-4">
          Where X, Meta (lead ads, Messenger and Instagram DMs) and WhatsApp deliver to. Subscribe Meta&apos;s
          webhook to the <b>leadgen</b> and <b>messages</b> fields, and WhatsApp&apos;s to <b>messages</b> — same
          verify token and app secret.
        </p>
        <div className="space-y-3">
          <div>
            <label className="label">X webhook callback URL</label>
            <code className="block text-sm bg-muted rounded-lg px-3 py-2">https://crm.denagocpt.co.za/api/webhooks/x{xAccountId ? `?account_id=${xAccountId}` : ""}</code>
          </div>
          <div>
            <label className="label">Meta webhook callback URL</label>
            <code className="block text-sm bg-muted rounded-lg px-3 py-2">https://crm.denagocpt.co.za/api/webhooks/meta</code>
          </div>
          <div>
            <label className="label">WhatsApp webhook callback URL</label>
            <code className="block text-sm bg-muted rounded-lg px-3 py-2">https://crm.denagocpt.co.za/api/webhooks/whatsapp</code>
          </div>
          <div>
            <label className="label">Verify token</label>
            <div className="flex gap-2">
              <SecretReveal settingKey="META_VERIFY_TOKEN" isSet={Boolean(setting("META_VERIFY_TOKEN"))} />
              <SaveForm success="New value generated" resetOnSuccess={false} action={regenerateSetting.bind(null, "META_VERIFY_TOKEN")}>
                <SaveButton className="btn-secondary">Regenerate</SaveButton>
              </SaveForm>
            </div>
          </div>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="META_APP_SECRET" />
            <input type="hidden" name="keepIfBlank" value="1" />
            <div className="flex-1">
              <label className="label">App secret (verifies webhook signatures)</label>
              <input
                name="value"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder={setting("META_APP_SECRET") ? "•••••••• saved — leave blank to keep" : "From Meta app → Settings → Basic"}
              />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
            {setting("META_APP_SECRET") ? <ClearSecret settingKey="META_APP_SECRET" label="Meta app secret" /> : null}
          </SaveForm>
        </div>
      </Row>

      {/*
        Telegram belongs HERE, with the other customer channels — and only here.
        TENANT_CREDENTIAL_INTEGRATIONS deliberately has no Telegram entry: a token
        stored as an override had no TELEGRAM_WEBHOOK_SECRET for
        resolveTelegramTenant to find, so Telegram could never deliver.

        `connectTelegram` is not a plain save. It stores the token, mints a
        per-tenant webhook secret, calls Telegram's setWebhook, and records
        whether that call succeeded — which is why the badge below can tell
        "token stored" apart from "actually receiving".
      */}
      <Row
        title="Telegram"
        status={
          !setting("TELEGRAM_BOT_TOKEN") ? (
            <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
          ) : setting("BOT_TG_ENABLED") === "true" ? (
            <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
          ) : (
            // The half-configured state, said out loud. A stored token with no
            // registered webhook receives nothing, and silently looking connected
            // is exactly how WhatsApp lost eighteen days.
            <span className="badge bg-amber-500/15 text-amber-300">Token saved · webhook not registered</span>
          )
        }
      >
        <p className="text-xs text-muted-foreground mb-4">
          Create a bot with <b>@BotFather</b> in Telegram, then paste the token it gives you. Connecting registers
          the webhook with Telegram for you — unlike WhatsApp and Meta, nothing needs configuring on their side.
          The bot runs the same published chatbot flow.
        </p>
        {!setting("TELEGRAM_BOT_TOKEN") ? (
          <form action={connectTelegram} className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="label">Bot token</label>
              <input name="token" type="password" autoComplete="new-password" className="input" placeholder="123456789:ABCdef…" />
            </div>
            <button className="btn-primary">Connect</button>
          </form>
        ) : (
          <div className="space-y-3">
            {setting("BOT_TG_ENABLED") !== "true" && (
              <p className="text-xs text-amber-300">
                Telegram did not accept the webhook registration, so nothing will arrive. Disconnect and reconnect
                with a fresh token from @BotFather.
              </p>
            )}
            <form action={disconnectTelegram}>
              <button className="btn-secondary">Disconnect</button>
            </form>
          </div>
        )}
      </Row>

      <Row
        title="Google Maps location autocomplete"
        status={
          setting("GOOGLE_MAPS_BROWSER_API_KEY") ? (
            <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
          ) : (
            <span className="badge bg-amber-500/15 text-amber-300">Text input fallback</span>
          )
        }
      >
        <p className="text-xs text-muted-foreground mb-4">
          Suggests verified South African addresses and places while booking test drives or scheduling meetings.
          Use a dedicated browser key with <b>Maps JavaScript API</b> and <b> Places API (New)</b> enabled,
          restricted to this CRM&apos;s website referrers. If unset or unavailable, location fields remain normal
          text inputs.
        </p>
        <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
          <input type="hidden" name="key" value="GOOGLE_MAPS_BROWSER_API_KEY" />
          <div className="flex-1">
            <label className="label">Maps JavaScript browser API key</label>
            <input
              name="value"
              type="password"
              className="input"
              defaultValue={setting("GOOGLE_MAPS_BROWSER_API_KEY")}
              placeholder="AIza..."
              autoComplete="off"
            />
          </div>
          <SaveButton className="btn-primary">Save</SaveButton>
        </SaveForm>
      </Row>

      <Row
        title="AI Assist (Claude)"
        status={
          setting("ANTHROPIC_API_KEY") ? (
            <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
          ) : (
            <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
          )
        }
      >
        <p className="text-xs text-muted-foreground mb-4">
          Powers the ✨ message check, 🔎 lead research and (optionally) automatic research on new leads.
          Suggestions only — the AI never changes data. Get a key at console.anthropic.com.
        </p>
        <div className="space-y-3">
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="ANTHROPIC_API_KEY" />
            <input type="hidden" name="keepIfBlank" value="1" />
            <div className="flex-1">
              <label className="label">Anthropic API key</label>
              <input
                name="value"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder={setting("ANTHROPIC_API_KEY") ? "•••••••• saved — leave blank to keep" : "sk-ant-…"}
              />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
            {setting("ANTHROPIC_API_KEY") ? <ClearSecret settingKey="ANTHROPIC_API_KEY" label="Anthropic API key" /> : null}
          </SaveForm>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex items-center gap-2">
            <input type="hidden" name="key" value="AI_AUTO_RESEARCH" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" name="value" value="true" defaultChecked={setting("AI_AUTO_RESEARCH") === "true"} className="h-4 w-4" />
              Automatically research every new lead (files a note within ~15 min)
            </label>
            <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
          </SaveForm>
        </div>
      </Row>

      <Row
        title="ChatGPT subscription (research)"
        status={
          chatGpt.state === "connected" ? (
            <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
          ) : (
            <span className="badge bg-amber-500/15 text-amber-300">Not connected</span>
          )
        }
      >
        <p className="text-xs text-muted-foreground mb-4">
          Run 🔎 lead research on your ChatGPT Plus or Pro plan instead of paying per token. Sign in once with your
          ChatGPT account. While connected, research — the button and automatic research — uses ChatGPT only. The
          ✨ message check and the WhatsApp bot still use the Anthropic key.
        </p>
        <div className="space-y-3">
          <ChatGptConnect initial={chatGpt} />
          {chatGpt.state === "connected" && (
            <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
              <input type="hidden" name="key" value="CODEX_MODEL" />
              <div className="flex-1">
                <label className="label">Model</label>
                <input name="value" className="input font-mono" defaultValue={chatGpt.model} />
              </div>
              <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
            </SaveForm>
          )}
        </div>
      </Row>

      <Row
        title="ElevenLabs (Voice)"
        status={
          setting("ELEVENLABS_API_KEY") ? (
            <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
          ) : (
            <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
          )
        }
      >
        <p className="text-xs text-muted-foreground mb-4">
          Voice for the WhatsApp assistant: transcribes inbound voice notes, and (with the toggle on) replies to a
          customer&apos;s voice note with a synthesised voice note — mirroring the customer. Get a key and copy a
          Voice ID at elevenlabs.io.
        </p>
        <div className="space-y-3">
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="ELEVENLABS_API_KEY" />
            <input type="hidden" name="keepIfBlank" value="1" />
            <div className="flex-1">
              <label className="label">ElevenLabs API key</label>
              {/* Never echo the stored secret into the DOM — blank field, keep-if-blank on save. */}
              <input name="value" type="password" autoComplete="new-password" className="input" placeholder={setting("ELEVENLABS_API_KEY") ? "•••••••• saved — leave blank to keep" : "Your ElevenLabs API key"} />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
            {setting("ELEVENLABS_API_KEY") ? <ClearSecret settingKey="ELEVENLABS_API_KEY" label="ElevenLabs API key" /> : null}
          </SaveForm>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="ELEVENLABS_VOICE_ID" />
            <div className="flex-1">
              <label className="label">Voice ID</label>
              <input name="value" className="input" defaultValue={setting("ELEVENLABS_VOICE_ID")} placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
          </SaveForm>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex items-center gap-2">
            <input type="hidden" name="key" value="WHATSAPP_VOICE_REPLIES" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" name="value" value="true" defaultChecked={setting("WHATSAPP_VOICE_REPLIES") === "true"} className="h-4 w-4" />
              Reply to voice notes with a voice note (mirror the customer)
            </label>
            <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
          </SaveForm>
        </div>
      </Row>

      <Row title="Website lead intake API" status={<span className="badge bg-emerald-500/15 text-emerald-300">Active</span>} action="View">
        <p className="text-xs text-muted-foreground mb-4">
          POST leads from the website or landing pages with the <code>X-Api-Key</code> header. Fields: name
          (required), email, phone, message, model, color, source.
        </p>
        <div className="space-y-3">
          <div>
            <label className="label">API key</label>
            <div className="flex gap-2">
              <SecretReveal settingKey="INTAKE_API_KEY" isSet={Boolean(setting("INTAKE_API_KEY"))} />
              <SaveForm success="New value generated" resetOnSuccess={false} action={regenerateSetting.bind(null, "INTAKE_API_KEY")}>
                <SaveButton className="btn-secondary">Regenerate</SaveButton>
              </SaveForm>
            </div>
          </div>
        </div>
      </Row>
    </>
  );
}
