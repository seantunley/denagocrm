import { prisma } from "@/lib/db";
import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { decryptValue } from "@/lib/settings";
import { getBotFaqs } from "@/lib/botAi";
import {
  saveBotSettings,
  addFaq,
  deleteFaq,
  whisperConfigured,
  connectTelegram,
  disconnectTelegram,
  telegramStatus,
} from "@/app/actions/bot";
import { PageHeader } from "@/components/page-header";

export default async function ChatbotSettingsPage() {
  await requireOwner();
  const [settings, botFaqs, hasWhisper, tg] = await Promise.all([
    prisma.appSetting.findMany(),
    getBotFaqs(),
    whisperConfigured(),
    telegramStatus(),
  ]);
  const setting = (key: string) => {
    const raw = settings.find((s) => s.key === key)?.value ?? "";
    try {
      return decryptValue(raw);
    } catch {
      return raw;
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Chatbot" description="Automated customer conversations across WhatsApp, Messenger, Instagram and Telegram." />

      <div className="max-w-3xl space-y-4">
        <form action={saveBotSettings} className="space-y-4">
          {/* Master switch */}
          <div className="card flex items-center justify-between gap-4">
            <div>
              <p className="font-medium">Chatbot</p>
              <p className="text-xs text-slate-500">Master switch — when off, no automatic replies go out on any channel.</p>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer shrink-0">
              <input type="checkbox" name="enabled" defaultChecked={setting("BOT_ENABLED") === "true"} className="h-4 w-4" />
              On
            </label>
          </div>

          {/* Where it runs */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where it runs &amp; how</p>
              <Link href="/bot-builder" className="btn-secondary btn-sm">Flow builder</Link>
            </div>
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span>
                <span className="text-sm font-medium">Guided flow (menus)</span>
                <span className="block text-xs text-slate-500">Tappable menus that branch into answers, bookings and the AI — on every channel. Off = plain keyword replies only.</span>
              </span>
              <input type="checkbox" name="flowEnabled" defaultChecked={setting("BOT_FLOW_ENABLED") === "true"} className="h-4 w-4 shrink-0" />
            </label>
            <label className="flex items-center justify-between gap-4 cursor-pointer border-t border-slate-800 pt-3">
              <span>
                <span className="text-sm font-medium">Messenger &amp; Instagram DMs</span>
                <span className="block text-xs text-slate-500">Run the flow on Facebook Messenger and Instagram DMs (uses your Meta connection).</span>
              </span>
              <input type="checkbox" name="dmEnabled" defaultChecked={setting("BOT_DM_ENABLED") === "true"} className="h-4 w-4 shrink-0" />
            </label>
          </div>

          {/* Intelligence */}
          <div className="card space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">AI assistant</p>
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span>
                <span className="text-sm font-medium">Claude replies to open questions</span>
                <span className="block text-xs text-slate-500">Grounded in your live prices, hours and the brief below; uses your FAQ pathways; hands off to a human when needed. Needs the Anthropic key (Settings → Integrations).</span>
              </span>
              <input type="checkbox" name="aiEnabled" defaultChecked={setting("BOT_AI_ENABLED") === "true"} className="h-4 w-4 shrink-0" />
            </label>
            <div>
              <label className="label">About us / policies (the bot&apos;s brief)</label>
              <textarea name="brief" className="input" rows={4} defaultValue={setting("BOT_AI_BRIEF") || ""} placeholder="Delivery areas & fees, warranty, finance, service turnaround, location, tone. The bot only states facts you give it here (plus live prices)." />
            </div>
            <div>
              <label className="label">Voice-note transcription key (OpenAI Whisper) — optional</label>
              <input name="whisperKey" className="input" type="password" placeholder={hasWhisper ? "•••••••• (saved — leave blank to keep)" : "sk-… — lets the bot understand WhatsApp voice notes"} />
            </div>
          </div>

          {/* Fallback, collapsed */}
          <details className="card">
            <summary className="text-sm font-medium cursor-pointer select-none">Office hours &amp; away message</summary>
            <p className="text-xs text-slate-500 mt-1 mb-3">Used for the after-hours away message when the AI assistant is off. An away message goes out at most once per customer per 4 hours.</p>
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="label">Office hours</label>
                <div className="flex items-center gap-1.5">
                  <input type="time" name="start" className="input w-28" defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[0]} />
                  <span className="text-slate-500">–</span>
                  <input type="time" name="end" className="input w-28" defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[1]} />
                </div>
              </div>
              <div>
                <label className="label">Days</label>
                <div className="flex gap-2 flex-wrap">
                  {[["1","Mo"],["2","Tu"],["3","We"],["4","Th"],["5","Fr"],["6","Sa"],["7","Su"]].map(([v,l]) => (
                    <label key={v} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                      <input type="checkbox" name="days" value={v} defaultChecked={(setting("BOT_DAYS") || "1,2,3,4,5").split(",").includes(v)} className="h-3.5 w-3.5" />
                      {l}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3">
              <label className="label">After-hours away message</label>
              <textarea name="afterhours" className="input" rows={2} defaultValue={setting("BOT_AFTERHOURS_MSG") || "Thanks for your message! Our showroom is open Mon–Fri 08:00–17:00 — we'll get back to you first thing. For urgent matters call 073 789 3438."} />
            </div>
          </details>

          <button className="btn-primary">Save bot settings</button>
        </form>

        {/* FAQ pathways */}
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">FAQ pathways</p>
          <p className="text-xs text-slate-500 mb-3">
            Canonical answers for common questions — the assistant matches each message to the right
            pathway and sends its exact answer. Price list and colours are built in from your products.
          </p>
          <ul className="space-y-2 mb-3">
            {botFaqs.length === 0 && (
              <li className="text-xs text-slate-500">No pathways yet — e.g. “asking about delivery / shipping” → your delivery areas and fees.</li>
            )}
            {botFaqs.map((f) => (
              <li key={f.id} className="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-orange-300">
                    {f.question}
                    {f.handoff && <span className="ml-2 text-amber-400">→ hands off</span>}
                  </p>
                  <p className="text-xs text-slate-400 whitespace-pre-wrap">{f.answer}</p>
                </div>
                <form action={deleteFaq.bind(null, f.id)}>
                  <button className="text-xs text-slate-600 hover:text-red-400 cursor-pointer">✕</button>
                </form>
              </li>
            ))}
          </ul>
          <details className="rounded-lg border border-slate-800 bg-slate-800/40">
            <summary className="px-3 py-2 text-sm font-medium cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">+ Add pathway</summary>
            <form action={addFaq} className="p-3 pt-1 space-y-2">
              <input name="question" className="input" required placeholder="When the customer is… — e.g. asking about delivery, shipping, how they get the cart" />
              <textarea name="answer" className="input" rows={3} required placeholder="The exact answer to send — e.g. We deliver anywhere in the Western Cape. Free within 50km of Cape Town, then R15/km." />
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" name="handoff" className="h-3.5 w-3.5" /> Hand off to a human after this answer
              </label>
              <button className="btn-primary btn-sm">Add pathway</button>
            </form>
          </details>
        </div>

        {/* Telegram */}
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
            Telegram {tg.connected && <span className="text-emerald-400 normal-case">· connected{tg.enabled ? " & live" : ""}</span>}
          </p>
          <p className="text-xs text-slate-500 mb-2">
            Create a bot with @BotFather, paste the token and Connect — it runs the same flow.
          </p>
          {!tg.connected ? (
            <form action={connectTelegram} className="flex gap-2">
              <input name="token" className="input flex-1" placeholder="123456789:ABCdef..." />
              <button className="btn-primary btn-sm shrink-0">Connect</button>
            </form>
          ) : (
            <form action={disconnectTelegram}>
              <button className="btn-secondary btn-sm">Disconnect</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
