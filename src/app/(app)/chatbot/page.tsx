import { prisma } from "@/lib/db";
import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { decryptValue } from "@/lib/settings";
import { getBotFaqs } from "@/lib/botAi";
import { getBotKnowledgeEntries, knowledgeIsCurrent } from "@/lib/botKnowledge";
import {
  saveBotSettings,
  addFaq,
  deleteFaq,
  addBotKnowledge,
  setBotKnowledgeStatus,
  deleteBotKnowledge,
  whisperConfigured,
  telegramStatus,
} from "@/app/actions/bot";
import ClearSecret from "@/components/ClearSecret";
import { Bot, BrainCircuit, BookOpenCheck, GitBranch, MessagesSquare, Radio } from "lucide-react";
import { WorkspaceHero } from "@/components/workspace-hero";
import { StatusPill, Surface } from "@/components/visual-system";

export default async function ChatbotSettingsPage() {
  await requireOwner();
  const [settings, botFaqs, knowledge, libraryDocuments, hasWhisper, tg] = await Promise.all([
    prisma.appSetting.findMany(),
    getBotFaqs(),
    getBotKnowledgeEntries(),
    prisma.libraryDocument.findMany({ select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: 100 }),
    whisperConfigured(),
    telegramStatus(),
  ]);
  const setting = (key: string) => {
    const raw = settings.find((s) => s.key === key)?.value ?? "";
    try { return decryptValue(raw); } catch { return raw; }
  };
  const botEnabled = setting("BOT_ENABLED") === "true";
  const flowEnabled = setting("BOT_FLOW_ENABLED") === "true";
  const aiEnabled = setting("BOT_AI_ENABLED") === "true";
  const approvedKnowledge = knowledge.filter((entry) => knowledgeIsCurrent(entry));

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={Bot}
        eyebrow="Customer conversations"
        title="Chatbot"
        description="Control how automated conversations greet, guide and hand customers over across every connected channel."
        stats={[
          { label: "Assistant", value: botEnabled ? "Live" : "Off", icon: Radio, tone: botEnabled ? "success" : "default" },
          { label: "Guided flow", value: flowEnabled ? "Enabled" : "Off", icon: GitBranch },
          { label: "AI answers", value: aiEnabled ? "Enabled" : "Off", icon: BrainCircuit },
          { label: "FAQ paths", value: botFaqs.length, icon: MessagesSquare },
          { label: "Approved knowledge", value: approvedKnowledge.length, icon: BookOpenCheck },
        ]}
        actions={<Link href="/bot-builder" className="btn-primary btn-sm"><GitBranch className="size-4" />Open flow builder</Link>}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
        <form action={saveBotSettings} className="space-y-4">
          <Surface className="flex items-center justify-between gap-4 p-5">
            <div>
              <p className="font-medium">Chatbot <StatusPill className="ml-2" tone={botEnabled ? "success" : "neutral"}>{botEnabled ? "Live" : "Off"}</StatusPill></p>
              <p className="text-xs text-muted-foreground">Master switch — when off, no automatic replies go out on any channel.</p>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer shrink-0">
              <input type="checkbox" name="enabled" defaultChecked={botEnabled} className="h-4 w-4" /> On
            </label>
          </Surface>

          <Surface className="space-y-3 p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where it runs &amp; how</p>
              <Link href="/bot-builder" className="btn-secondary btn-sm">Flow builder</Link>
            </div>
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span><span className="text-sm font-medium">Guided flow (menus)</span><span className="block text-xs text-muted-foreground">Tappable menus that branch into answers, bookings and the AI — on every connected channel.</span></span>
              <input type="checkbox" name="flowEnabled" defaultChecked={flowEnabled} className="h-4 w-4 shrink-0" />
            </label>
            <label className="flex items-center justify-between gap-4 cursor-pointer border-t border-border pt-3">
              <span><span className="text-sm font-medium">Messenger &amp; Instagram DMs</span><span className="block text-xs text-muted-foreground">Run the published flow on Facebook Messenger and Instagram DMs.</span></span>
              <input type="checkbox" name="dmEnabled" defaultChecked={setting("BOT_DM_ENABLED") === "true"} className="h-4 w-4 shrink-0" />
            </label>
          </Surface>

          <Surface className="space-y-3 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI assistant</p>
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <span>
                <span className="text-sm font-medium">Claude replies to open questions</span>
                <span className="block text-xs text-muted-foreground">Uses live product facts, canonical FAQ paths and only approved/current knowledge. Open-ended answers require high confidence; uncertain questions hand over.</span>
              </span>
              <input type="checkbox" name="aiEnabled" defaultChecked={aiEnabled} className="h-4 w-4 shrink-0" />
            </label>
            <div>
              <label className="label">About us / policies (short global brief)</label>
              <textarea name="brief" className="input" rows={4} defaultValue={setting("BOT_AI_BRIEF") || ""} placeholder="General tone, location and stable facts. Put detailed policies/specifications into Approved knowledge so they can be reviewed and expired independently." />
            </div>
            <div>
              <label className="label">Voice-note transcription key (OpenAI Whisper) — optional fallback</label>
              <div className="flex gap-2">
                <input name="whisperKey" className="input flex-1" type="password" autoComplete="new-password" placeholder={hasWhisper ? "•••••••• (saved — leave blank to keep)" : "sk-… — fallback if ElevenLabs isn't set"} />
                {hasWhisper ? <ClearSecret settingKey="OPENAI_API_KEY" label="OpenAI Whisper key" /> : null}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Voice replies &amp; the ElevenLabs key/voice live in <b>Settings → Integrations → ElevenLabs</b>.</p>
            </div>
          </Surface>

          <details className="card p-5">
            <summary className="text-sm font-medium cursor-pointer select-none">Office hours &amp; away message</summary>
            <p className="text-xs text-muted-foreground mt-1 mb-3">Used for the after-hours away message when the AI assistant is off. An away message goes out at most once per customer per 4 hours.</p>
            <div className="flex items-end gap-3 flex-wrap">
              <div><label className="label">Office hours</label><div className="flex items-center gap-1.5"><input type="time" name="start" className="input w-28" defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[0]} /><span className="text-muted-foreground">–</span><input type="time" name="end" className="input w-28" defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[1]} /></div></div>
              <div><label className="label">Days</label><div className="flex gap-2 flex-wrap">{[["1","Mo"],["2","Tu"],["3","We"],["4","Th"],["5","Fr"],["6","Sa"],["7","Su"]].map(([v,l]) => <label key={v} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer"><input type="checkbox" name="days" value={v} defaultChecked={(setting("BOT_DAYS") || "1,2,3,4,5").split(",").includes(v)} className="h-3.5 w-3.5" />{l}</label>)}</div></div>
            </div>
            <div className="mt-3"><label className="label">After-hours away message</label><textarea name="afterhours" className="input" rows={2} defaultValue={setting("BOT_AFTERHOURS_MSG") || "Thanks for your message! Our showroom is open Mon–Fri 08:00–17:00 — we'll get back to you first thing."} /></div>
          </details>

          <button className="btn-primary">Save bot settings</button>
        </form>

        <aside className="space-y-4 xl:sticky xl:top-5">
          <Surface className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">FAQ pathways</p>
            <p className="text-xs text-muted-foreground mb-3">Canonical answers for common questions. When matched, the exact owner-approved answer is sent.</p>
            <ul className="space-y-2 mb-3">
              {botFaqs.length === 0 && <li className="text-xs text-muted-foreground">No pathways yet.</li>}
              {botFaqs.map((f) => <li key={f.id} className="rounded-lg border border-border bg-muted/40 px-3 py-2 flex items-start gap-3"><div className="flex-1 min-w-0"><p className="text-xs font-semibold text-primary">{f.question}{f.handoff && <span className="ml-2 text-amber-400">→ hands off</span>}</p><p className="text-xs text-muted-foreground whitespace-pre-wrap">{f.answer}</p></div><form action={deleteFaq.bind(null, f.id)}><button className="text-xs text-muted-foreground hover:text-red-400 cursor-pointer">✕</button></form></li>)}
            </ul>
            <details className="rounded-lg border border-border bg-muted/40">
              <summary className="px-3 py-2 text-sm font-medium cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">+ Add pathway</summary>
              <form action={addFaq} className="p-3 pt-1 space-y-2"><input name="question" className="input" required placeholder="When the customer is…" /><textarea name="answer" className="input" rows={3} required placeholder="The exact answer to send" /><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" name="handoff" className="h-3.5 w-3.5" /> Hand off after this answer</label><button className="btn-primary btn-sm">Add pathway</button></form>
            </details>
          </Surface>

          <Surface className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Approved knowledge</p><p className="mt-1 text-xs text-muted-foreground">Curated facts and policy excerpts retrieved only when relevant. Drafts are never shown to the AI.</p></div>
              <StatusPill tone="success">{approvedKnowledge.length} live</StatusPill>
            </div>
            <ul className="mt-3 space-y-2">
              {knowledge.length === 0 && <li className="text-xs text-muted-foreground">No knowledge entries yet. Add warranty, delivery, finance, service or product facts below.</li>}
              {knowledge.slice(0, 30).map((entry) => {
                const current = knowledgeIsCurrent(entry);
                const statusLabel = entry.status === "approved" && !current ? "Expired by date" : entry.status;
                return (
                  <li key={entry.id} className="rounded-xl border border-border bg-muted/35 p-3">
                    <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><p className="text-xs font-semibold text-foreground">{entry.title}</p><span className={`rounded-full px-1.5 py-0.5 text-[10px] ${current ? "bg-emerald-500/15 text-emerald-300" : entry.status === "draft" ? "bg-amber-500/15 text-amber-300" : "bg-slate-500/15 text-slate-400"}`}>{statusLabel}</span></div>{entry.sourceLabel && <p className="mt-0.5 text-[10px] text-muted-foreground">Source: {entry.sourceLabel}</p>}</div><form action={deleteBotKnowledge.bind(null, entry.id)}><button className="text-xs text-muted-foreground hover:text-red-400" aria-label={`Delete ${entry.title}`}>✕</button></form></div>
                    <p className="mt-2 line-clamp-5 whitespace-pre-wrap text-xs text-muted-foreground">{entry.content}</p>
                    {(entry.validFrom || entry.validUntil) && <p className="mt-1 text-[10px] text-muted-foreground">{entry.validFrom ? `From ${new Date(entry.validFrom).toLocaleDateString("en-ZA")}` : ""}{entry.validFrom && entry.validUntil ? " · " : ""}{entry.validUntil ? `Until ${new Date(entry.validUntil).toLocaleDateString("en-ZA")}` : ""}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {entry.status !== "approved" && <form action={setBotKnowledgeStatus.bind(null, entry.id, "approved")}><button className="btn-primary btn-sm">Approve</button></form>}
                      {entry.status === "approved" && <form action={setBotKnowledgeStatus.bind(null, entry.id, "expired")}><button className="btn-secondary btn-sm">Expire</button></form>}
                      {entry.status === "expired" && <form action={setBotKnowledgeStatus.bind(null, entry.id, "draft")}><button className="btn-secondary btn-sm">Return to draft</button></form>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <details className="mt-3 rounded-lg border border-border bg-muted/40">
              <summary className="px-3 py-2 text-sm font-medium cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">+ Add knowledge draft</summary>
              <form action={addBotKnowledge} className="space-y-2 p-3 pt-1">
                <input name="title" className="input" required maxLength={180} placeholder="Warranty coverage — batteries" />
                <textarea name="content" className="input" rows={5} required maxLength={5000} placeholder="Paste the precise fact or approved excerpt the assistant may rely on. This is the customer-facing source of truth after approval." />
                <div><label className="label">Library source (optional)</label><select name="sourceDocumentId" className="input"><option value="">Manual / no document</option>{libraryDocuments.map((doc) => <option key={doc.id} value={doc.id}>{doc.name}</option>)}</select></div>
                <div className="grid grid-cols-2 gap-2"><div><label className="label">Valid from</label><input type="date" name="validFrom" className="input" /></div><div><label className="label">Valid until</label><input type="date" name="validUntil" className="input" /></div></div>
                <p className="text-[10px] leading-4 text-muted-foreground">New entries are always Draft. Review them, then click Approve separately.</p>
                <button className="btn-primary btn-sm">Add draft</button>
              </form>
            </details>
          </Surface>

          <Surface className="p-5">
            {/*
              Status here, connecting in Settings.

              This card used to carry its own Connect form, which made Telegram
              the only channel with two doors — and the only one absent from the
              screen that lists customer channels. Showing where the bot runs is
              useful on this page; being a second place to configure it is how
              the two drift apart.
            */}
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Telegram {tg.connected && <span className={tg.enabled ? "text-emerald-400 normal-case" : "text-amber-300 normal-case"}>· {tg.enabled ? "connected & live" : "token saved, webhook not registered"}</span>}</p>
            <p className="text-xs text-muted-foreground mb-2">
              {tg.connected
                ? "Your Telegram bot runs this same published flow."
                : "Connect a Telegram bot to run this same published flow on Telegram."}
            </p>
            <Link href="/settings?tab=integrations" className="btn-secondary btn-sm">
              {tg.connected ? "Manage in Settings" : "Set up in Settings"}
            </Link>
          </Surface>
        </aside>
      </div>
    </div>
  );
}
