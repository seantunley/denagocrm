import type { ReactNode } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import SecretReveal from "@/components/SecretReveal";
import ClearSecret from "@/components/ClearSecret";
import ChatGptConnect from "@/components/settings/ChatGptConnect";
import type { IntegrationState } from "@/lib/integrationsCatalogue";
import { saveSetting, regenerateSetting } from "@/app/actions/settings";
import { connectTelegram, disconnectTelegram } from "@/app/actions/bot";
import { getSetting } from "@/lib/settings";
import { saveAiModel } from "@/app/actions/aiModel";
import { codexModel, codexStatus, type CodexStatus } from "@/lib/codex";
import { CODEX_DEFAULT_MODEL, CODEX_QUICK_MODEL } from "@/lib/codexProtocol";
import { AI_CLAUDE_MODEL_KEY, AI_PROVIDER_CHOICES, claudeModelFor, pickAiProvider } from "@/lib/aiProviderRules";
import { aiModelCatalog } from "@/lib/aiModelCatalog";
import VoicePicker from "@/components/settings/VoicePicker";
import { DEFAULT_TTS_MODEL, TTS_MODELS, VOICE_SPEEDS, elevenLabsVoices, modelTakesSpeed } from "@/lib/elevenlabs";
import { STT_CUSTOMER_NAMES_KEY, TTS_MODEL_KEY, VOICE_SPEED_KEY } from "@/lib/voiceSettings";
import { PRONUNCIATIONS_KEY } from "@/lib/spokenText";
import { PLATFORM_URL } from "@/lib/platformLegal";

/** The workspace settings these rows read. Never per-tenant-credential keys — those are the page's own forms. */
const KEYS = [
  "META_VERIFY_TOKEN",
  "META_APP_SECRET",
  "META_APP_ID",
  "META_LOGIN_CONFIG_ID",
  "WA_SIGNUP_CONFIG_ID",
  "TELEGRAM_BOT_TOKEN",
  "BOT_TG_ENABLED",
  "GOOGLE_MAPS_BROWSER_API_KEY",
  "ANTHROPIC_API_KEY",
  "AI_AUTO_RESEARCH",
  "AI_PROVIDER",
  "AI_CLAUDE_MODEL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_TTS_MODEL",
  "ELEVENLABS_VOICE_SPEED",
  "ELEVENLABS_PRONUNCIATIONS",
  "ELEVENLABS_STT_CUSTOMER_NAMES",
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
/** One platform-owner row, for the page to group by purpose with the workspace's own integrations. */
export type PlatformIntegrationRow = {
  id: string;
  title: string;
  state: IntegrationState;
  detail?: string | null;
  body: ReactNode;
};

export default async function platformIntegrationRows({ xAccountId }: { xAccountId: string | null }): Promise<PlatformIntegrationRow[]> {
  const values = new Map(await Promise.all(KEYS.map(async (key) => [key, (await getSetting(key)) ?? ""] as const)));
  const setting = (key: (typeof KEYS)[number]) => values.get(key) ?? "";
  // A read that fails must not take the page down with it.
  const chatGpt: CodexStatus = await codexStatus().catch((): CodexStatus => ({ state: "disconnected" }));
  // The voices in the ElevenLabs account, for the picker; null (a typed ID instead) when there is no key or it fails.
  const voices = setting("ELEVENLABS_API_KEY") ? await elevenLabsVoices().catch(() => null) : null;
  // What the chatbot and AI helpers actually run on now: the choice — or ChatGPT when Claude is chosen without a key.
  // Never Claude in place of ChatGPT (pickAiProvider): then the AI is off, and the row says so.
  const aiInUse = pickAiProvider(setting("AI_PROVIDER"), chatGpt.state === "connected", Boolean(setting("ANTHROPIC_API_KEY")));
  const aiChosen = setting("AI_PROVIDER") === "claude" ? "claude" : "chatgpt";
  // The one model picker: the models each provider lists for this workspace (lib/aiModelCatalog), the built-in lists
  // when it can't be asked. ChatGPT's model is read through the same scoped read as the status, connected or not.
  const chatGptModel = chatGpt.state === "connected" ? chatGpt.model : await codexModel().catch(() => CODEX_DEFAULT_MODEL);
  // What runs (claudeModelFor: a saved model with no listed price is not used) vs what was saved — shown, disabled.
  const claudeSaved = setting(AI_CLAUDE_MODEL_KEY);
  const claudeChosen = claudeModelFor(claudeSaved, "");
  const claudeSavedUnpriced = Boolean(claudeSaved) && !claudeChosen;
  const catalog = await aiModelCatalog({ chatgpt: chatGptModel, claude: claudeSaved });
  const modelGroups = {
    chatgpt: catalog.chatgpt.map((choice) => ({ value: `chatgpt:${choice.id}`, label: choice.label, disabled: false })),
    claude: catalog.claude.map((choice) => ({ value: `claude:${choice.id}`, label: choice.label, disabled: Boolean(choice.disabled) })),
  };
  // Nothing hidden: say which lists came from the provider and which are the built-in fallback.
  const listSource = [
    chatGpt.state === "connected" ? `ChatGPT's models ${catalog.chatgptLive ? "are as ChatGPT lists them" : "are the built-in list (ChatGPT couldn't be asked just now)"}` : null,
    setting("ANTHROPIC_API_KEY") ? `Claude's ${catalog.claudeLive ? "are as Anthropic lists them" : "are the built-in list (Anthropic couldn't be asked just now)"}` : null,
  ].filter(Boolean).join("; ");
  const modelChosen = aiChosen === "claude" ? `claude:${claudeChosen}` : `chatgpt:${chatGptModel}`;
  const modelInUse = aiInUse === "chatgpt" ? chatGptModel : claudeChosen || "automatic";

  const on = (value: string): IntegrationState => (value ? "connected" : "not-set-up");
  return [
    {
      id: "webhooks",
      title: "Webhooks (X, Meta, WhatsApp)",
      state: on(setting("META_VERIFY_TOKEN")),
      body: (
      <>
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
          {/* Connect Facebook (lib/metaConnect.ts, 2026-11-21): the CRM's own Meta app that every business signs in through. */}
          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground mb-2">
              <b>Connect Facebook</b> — businesses sign in through this app and pick their own Page. Add the redirect URI
              below to the app&apos;s Facebook Login → Valid OAuth Redirect URIs.
            </p>
            <label className="label">OAuth redirect URI</label>
            <code className="block text-sm bg-muted rounded-lg px-3 py-2">{`${PLATFORM_URL}/api/integrations/meta/callback`}</code>
          </div>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="META_APP_ID" />
            <div className="flex-1">
              <label className="label">App ID</label>
              <input name="value" className="input" defaultValue={setting("META_APP_ID")} placeholder="Meta app → Settings → Basic → App ID" />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
          </SaveForm>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="META_LOGIN_CONFIG_ID" />
            <div className="flex-1">
              <label className="label">Login for Business configuration ID (optional)</label>
              <input name="value" className="input" defaultValue={setting("META_LOGIN_CONFIG_ID")} placeholder="Facebook Login for Business → Configurations — blank asks for the permissions directly" />
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
          </SaveForm>
          {/* Connect WhatsApp (lib/whatsappConnect.ts): Meta's Embedded Signup on this same app. Blank = switched off. */}
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
            <input type="hidden" name="key" value="WA_SIGNUP_CONFIG_ID" />
            <div className="flex-1">
              <label className="label">WhatsApp Embedded Signup configuration ID</label>
              <input name="value" className="input" defaultValue={setting("WA_SIGNUP_CONFIG_ID")} placeholder="Facebook Login for Business → Configurations → WhatsApp Embedded Signup (v4) — blank keeps Connect WhatsApp off" />
              <p className="mt-1 text-xs text-muted-foreground">
                The popup runs on <code>{PLATFORM_URL}</code> — add that domain to the app&apos;s Allowed Domains and Valid OAuth Redirect URIs.
              </p>
            </div>
            <SaveButton className="btn-primary">Save</SaveButton>
          </SaveForm>
        </div>
      </>
      ),
    },

    /*
      Telegram belongs HERE, with the other customer channels — and only here.
      TENANT_CREDENTIAL_INTEGRATIONS deliberately has no Telegram entry: a token
      stored as an override had no TELEGRAM_WEBHOOK_SECRET for
      resolveTelegramTenant to find, so Telegram could never deliver.

      `connectTelegram` is not a plain save. It stores the token, mints a
      per-tenant webhook secret, calls Telegram's setWebhook, and records
      whether that call succeeded — which is why the status can tell "token
      stored" apart from "actually receiving".
    */
    {
      id: "telegram",
      title: "Telegram",
      // The half-configured state, said out loud — and it rises to Needs attention. A stored
      // token with no registered webhook receives nothing, and silently looking connected is
      // exactly how WhatsApp lost eighteen days.
      state: !setting("TELEGRAM_BOT_TOKEN") ? "not-set-up" : setting("BOT_TG_ENABLED") === "true" ? "connected" : "incomplete",
      detail: setting("TELEGRAM_BOT_TOKEN") && setting("BOT_TG_ENABLED") !== "true" ? "Token saved, but Telegram didn't accept the webhook — nothing arrives" : null,
      body: (
      <>
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
      </>
      ),
    },
    {
      id: "google-maps",
      title: "Google Maps address suggestions",
      state: on(setting("GOOGLE_MAPS_BROWSER_API_KEY")),
      detail: setting("GOOGLE_MAPS_BROWSER_API_KEY") ? null : "Without it, location fields are plain text boxes",
      body: (
      <>
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
      </>
      ),
    },
    {
      id: "ai-choice",
      title: "Which AI the CRM uses",
      // A status, not a value: which AI is in use goes on the detail line.
      state: aiInUse ? "connected" : "not-set-up",
      detail: aiInUse ? `Using ${aiInUse === "chatgpt" ? "ChatGPT" : "Claude"} · ${modelInUse}${aiInUse !== aiChosen ? ` (${aiChosen === "chatgpt" ? "ChatGPT" : "Claude"} isn't set up)` : ""}` : null,
      body: (
      <>
        <p className="text-xs text-muted-foreground mb-4">
          The customer chatbot, invoice reading, the ✨ message check, voice-note replies, spam screening and 🔎 research
          run on the model chosen here. A ChatGPT model runs on your subscription, with no per-use cost, and is DAX&apos;s
          model too. A Claude model is paid per use from Anthropic credit. Either way, quick and automatic jobs (chatbot
          replies, spam screening, the automatic lead research) stay on a quick, low-cost model ({CODEX_QUICK_MODEL} or
          Claude Haiku); the model chosen here runs the jobs someone asks for. DAX always uses ChatGPT. If ChatGPT
          isn&apos;t connected the AI is off — it never moves to paid Claude credit by itself.
        </p>
        <SaveForm resetOnSuccess={false} action={saveAiModel} className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label" htmlFor="ai-model">AI model</label>
            <select id="ai-model" name="value" className="input" defaultValue={modelChosen}>
              {AI_PROVIDER_CHOICES.map((provider) => (
                <optgroup key={provider.id} label={provider.label}>
                  {modelGroups[provider.id].map((choice) => (
                    <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
        </SaveForm>
        {listSource && <p className="mt-2 text-xs text-muted-foreground">{listSource}.</p>}
        {claudeSavedUnpriced && (
          <p className="mt-2 text-xs text-amber-300" role="status">
            The Claude model saved here ({claudeSaved}) has no listed price yet, so it isn&apos;t used: Claude jobs run on their
            own models until the weekly price update lists it. Choose another model to change that.
          </p>
        )}
        {aiInUse && aiInUse !== aiChosen && (
          <p className="mt-2 text-xs text-amber-300" role="status">
            There&apos;s no Anthropic key, so ChatGPT is being used.
          </p>
        )}
        {!aiInUse && aiChosen === "chatgpt" && setting("ANTHROPIC_API_KEY") && (
          <p className="mt-2 text-xs text-amber-300" role="status">
            ChatGPT isn&apos;t connected, so the AI is off. Reconnect ChatGPT below, or choose a Claude model to use
            Anthropic credit.
          </p>
        )}
      </>
      ),
    },
    {
      id: "claude",
      title: "AI Assist (Claude)",
      state: on(setting("ANTHROPIC_API_KEY")),
      body: (
      <>
        <p className="text-xs text-muted-foreground mb-4">
          Pay-per-use Claude, used only when &quot;Which AI the CRM uses&quot; is set to a Claude model.
          Suggestions only — the AI never changes data. Get a key and load credit at console.anthropic.com.
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
      </>
      ),
    },
    {
      id: "chatgpt",
      title: "ChatGPT subscription",
      state: chatGpt.state === "connected" ? "connected" : "not-set-up",
      detail: chatGpt.state === "connected" ? `Model ${chatGpt.model}` : null,
      body: (
      <>
        <p className="text-xs text-muted-foreground mb-4">
          DAX, the customer chatbot and the other AI helpers run on your ChatGPT Plus or Pro plan instead of paying per
          token (unless &quot;Which AI the CRM uses&quot; is set to a Claude model). Sign in once with your ChatGPT account.
        </p>
        <div className="space-y-3">
          <ChatGptConnect initial={chatGpt} />
          {/* Only while Claude is the chosen AI: otherwise the model picker under "Which AI the CRM uses" is this same setting. */}
          {chatGpt.state === "connected" && aiChosen === "claude" && (
            <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
              <input type="hidden" name="key" value="CODEX_MODEL" />
              <div className="flex-1">
                <label className="label" htmlFor="codex-model">DAX and research model</label>
                <select id="codex-model" name="value" className="input font-mono" defaultValue={chatGpt.model}>
                  {catalog.chatgpt.map((choice) => (
                    <option key={choice.id} value={choice.id}>{choice.label}</option>
                  ))}
                </select>
              </div>
              <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
            </SaveForm>
          )}
          {chatGpt.state === "connected" && chatGpt.switched && (
            <p className="text-xs text-amber-300" role="status">
              ChatGPT refused <span className="font-mono">{chatGpt.switched.from}</span> on{" "}
              {new Date(chatGpt.switched.at).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}, so DAX switched
              to <span className="font-mono">{chatGpt.switched.to}</span> to keep working. Choose another model{aiChosen === "claude" ? " above" : " under “Which AI the CRM uses”"} if you prefer.
            </p>
          )}
        </div>
      </>
      ),
    },
    {
      id: "elevenlabs",
      title: "ElevenLabs (Voice)",
      state: on(setting("ELEVENLABS_API_KEY")),
      detail: setting("ELEVENLABS_API_KEY") && setting("WHATSAPP_VOICE_REPLIES") === "true" ? "Replies to voice notes with a voice note" : null,
      body: (
      <>
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
          <VoicePicker voices={voices} current={setting("ELEVENLABS_VOICE_ID")} />
          <div className="grid gap-3 sm:grid-cols-2">
            <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
              <input type="hidden" name="key" value={TTS_MODEL_KEY} />
              <div className="flex-1">
                <label className="label">Voice model</label>
                <select name="value" className="input" defaultValue={TTS_MODELS.some((m) => m.id === setting(TTS_MODEL_KEY)) ? setting(TTS_MODEL_KEY) : DEFAULT_TTS_MODEL}>
                  {TTS_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
              <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
            </SaveForm>
            {/* Only a model that takes it shows it (v4 and v3 have no speed control — ElevenLabs' docs; review of #935). */}
            {modelTakesSpeed(TTS_MODELS.some((m) => m.id === setting(TTS_MODEL_KEY)) ? setting(TTS_MODEL_KEY) : DEFAULT_TTS_MODEL) ? (
              <SaveForm resetOnSuccess={false} action={saveSetting} className="flex gap-2 items-end">
                <input type="hidden" name="key" value={VOICE_SPEED_KEY} />
                <div className="flex-1">
                  <label className="label">Speaking speed</label>
                  <select name="value" className="input" defaultValue={(VOICE_SPEEDS as readonly string[]).includes(setting(VOICE_SPEED_KEY)) ? setting(VOICE_SPEED_KEY) : "1"}>
                    {VOICE_SPEEDS.map((s) => <option key={s} value={s}>{s === "1" ? "Normal" : Number(s) < 1 ? `Slower (${s})` : `Faster (${s})`}</option>)}
                  </select>
                </div>
                <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
              </SaveForm>
            ) : (
              <p className="text-xs text-muted-foreground self-end">
                Speaking speed isn&apos;t adjustable with Eleven v4 or v3 — they pace themselves. Choose Multilingual v2 or
                Flash v2.5 to set a speed.
              </p>
            )}
          </div>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="space-y-2">
            <input type="hidden" name="key" value={PRONUNCIATIONS_KEY} />
            <label className="label">How to say names (one per line: word = how to say it)</label>
            <textarea name="value" rows={4} className="input font-mono text-xs" defaultValue={setting(PRONUNCIATIONS_KEY)} placeholder={"Denago = Deh-NAH-go\nTokai = Toh-KAI"} />
            <p className="text-xs text-muted-foreground">Used whenever DAX or the chatbot speaks, and to help transcribe voice notes with these words spelt right.</p>
            <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
          </SaveForm>
          <SaveForm resetOnSuccess={false} action={saveSetting} className="flex items-start gap-2">
            <input type="hidden" name="key" value={STT_CUSTOMER_NAMES_KEY} />
            <label className="flex items-start gap-2 text-sm text-muted-foreground cursor-pointer">
              <input type="checkbox" name="value" value="on" defaultChecked={setting(STT_CUSTOMER_NAMES_KEY) === "on"} className="h-4 w-4 mt-0.5" />
              <span>
                Help transcription spell your customers&apos; names — sends the names of customers with open deals to
                ElevenLabs with each voice note. Product, staff and business names are always sent. (Off by default.)
              </span>
            </label>
            <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
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
      </>
      ),
    },
    {
      id: "intake",
      title: "Website lead intake",
      state: on(setting("INTAKE_API_KEY")),
      body: (
      <>
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
      </>
      ),
    },
  ];
}
