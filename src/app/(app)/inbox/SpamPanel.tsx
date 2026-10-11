import Link from "next/link";
import { basePrisma } from "@/lib/db";
import SpamQuarantine, { type QuarantineRow } from "@/components/SpamQuarantine";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { Surface } from "@/components/visual-system";
import { CLASS_LABEL, inertPreview, reasonText, type ScreeningClass } from "@/lib/inboundScreening/rules";
import { screeningSettings } from "@/lib/inboundScreening/screen";
import { restoreLeaseCutoff, screeningMetrics } from "@/lib/inboundScreening/review";
import { clearSenderRule, decideSpamPattern, saveScreeningSettings } from "@/app/actions/inboundSpam";
import { formatDateTime } from "@/lib/format";

import { REVIEW_VIEWS, reviewFilters, reviewMessages, reviewPageHref, type ReviewParams } from "@/lib/inboundScreening/queue";

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram" };

/** How many messages are held right now — the tab's count. One workspace, named. */
export async function quarantineCount(tenantId: string): Promise<number> {
  // "Held" includes a restore that was interrupted (its claim has gone stale): it
  // is back in the list, so a message can never sit unseen in a half-done state.
  return basePrisma.inboundScreening.count({ where: { tenantId, OR: [{ state: "quarantined" }, { state: "restoring", updatedAt: { lt: restoreLeaseCutoff() } }] } });
}

/** Senders (by contact and channel) whose recent messages the filter read as a business approach. One workspace, named. */
export async function businessApproachSenders(tenantId: string): Promise<{ contactId: string | null; channel: string }[]> {
  return basePrisma.inboundScreening.findMany({
    where: { tenantId, classification: "business_approach", state: { in: ["admitted", "restored"] }, contactId: { not: null }, receivedAt: { gt: new Date(Date.now() - 90 * 24 * 3600 * 1000) } },
    distinct: ["contactId", "channel"],
    select: { contactId: true, channel: true },
    take: 500,
  });
}

/**
 * Inbox → Spam. Everything is read for ONE named workspace. Message text is
 * made inert here, on the server, before it reaches the browser.
 */
export default async function SpamPanel({ tenantId, canReview, isOwner, params = {} }: { tenantId: string; canReview: boolean; isOwner: boolean; params?: ReviewParams }) {
  const filters = reviewFilters(params);
  const [queue, rules, patterns, metrics, settings] = await Promise.all([
    reviewMessages(tenantId, filters),
    basePrisma.inboundSenderRule.findMany({ where: { tenantId }, orderBy: { updatedAt: "desc" }, take: 200 }),
    basePrisma.inboundSpamPattern.findMany({ where: { tenantId, status: { in: ["proposed", "active"] } }, orderBy: [{ status: "asc" }, { hits: "desc" }], take: 100 }),
    screeningMetrics(tenantId, 30),
    screeningSettings(),
  ]);

  const senderLabel = (channel: string, senderId: string, name: string | null) => name?.trim() || (channel === "whatsapp" ? `+${senderId}` : `${channelLabel[channel] ?? channel} user …${senderId.slice(-4)}`);
  const rows: QuarantineRow[] = queue.rows.map((r) => ({
    id: r.id, channel: r.channel, sender: senderLabel(r.channel, r.senderId, r.senderName),
    receivedAt: r.receivedAt.toISOString(), preview: inertPreview(r.body), fullText: inertPreview(r.body, 4001),
    state: r.state, observed: r.mode === "observe" && r.state === "admitted", staffLabel: r.staffLabel,
    reason: (r.state === "restoring" ? "A restore of this message was interrupted — restore it again. " : "") + (r.reason || reasonText(r.reasonCodes, CLASS_LABEL[r.classification as ScreeningClass] ?? "Held")),
    cause: r.decidedBy === "sender_block" ? "blocked" : "filter",
  }));
  const { mode, policy } = settings;
  const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

  return (
    <div className="space-y-6">
      {mode === "off" && (
        <Surface className="border-border p-4">
          <p className="text-sm font-medium">The spam filter is off</p>
          <p className="mt-1 text-xs text-muted-foreground">Every message is handled exactly as before. {isOwner ? "Switch it to “Observe only” below to see what it would hold, without changing anything." : "A workspace owner can switch it on below."}</p>
        </Surface>
      )}
      {mode === "observe" && (
        <Surface className="border-sky-500/30 bg-sky-500/[0.06] p-4">
          <p className="text-sm font-medium text-sky-200">Observe only — nothing is being held</p>
          <p className="mt-1 text-xs text-muted-foreground">The filter is judging each message and recording what it would do, but every message still reaches the inbox, the chatbot and your notifications as normal. In the last 30 days it would have held <b>{metrics.observedWouldQuarantine}</b> of <b>{metrics.screened}</b>.</p>
        </Surface>
      )}

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Message review</h2><p className="mt-1 text-xs text-muted-foreground">Review held messages, check Observe decisions, or find spam that reached the inbox. Confirmed spam is kept separately; nothing is deleted automatically.</p></div>
        <form action="/inbox" method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value="spam" />
          <label className="text-xs">View<select name="spamView" defaultValue={filters.view} className="input mt-1">
            {Object.entries(REVIEW_VIEWS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="text-xs">Channel<select name="spamChannel" defaultValue={filters.channel} className="input mt-1">
            <option value="">All channels</option>{Object.entries(channelLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="text-xs">Decision<select name="spamCause" defaultValue={filters.cause} className="input mt-1">
            <option value="">All decisions</option><option value="filter">Filter decisions</option><option value="blocked">Blocked senders</option>
          </select></label>
          <label className="min-w-48 flex-1 text-xs">Search messages or senders<input name="spamSearch" defaultValue={filters.search} maxLength={120} className="input mt-1" /></label>
          <button type="submit" className="btn-secondary btn-sm">Apply filters</button>
        </form>
        {filters.view === "observe" && <p className="mb-3 text-xs text-muted-foreground">These messages already reached the inbox. Confirm spam or mark them not spam to assess the filter before enabling Quarantine. Feedback does not replay messages or activate broad rules.</p>}
        <SpamQuarantine key={`${filters.view}:${queue.page}:${filters.search}:${filters.channel}:${filters.cause}`} rows={rows} canReview={canReview} />
        <nav aria-label="Message review pages" className="mt-3 flex items-center justify-between gap-3 text-xs">
          {queue.page > 1 ? <Link href={reviewPageHref(filters, queue.page - 1)} scroll={false} className="btn-secondary btn-sm">Previous</Link> : <span />}
          <span>{queue.total} messages · Page {queue.page} of {queue.pages}</span>
          {queue.page < queue.pages ? <Link href={reviewPageHref(filters, queue.page + 1)} scroll={false} className="btn-secondary btn-sm">Next</Link> : <span />}
        </nav>
      </section>

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Sender decisions</h2><p className="mt-1 text-xs text-muted-foreground">Your own standing decisions about a sender — separate from what the filter thinks of any one message. They apply to that number or account on that channel only, never to a name.</p></div>
        {rules.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">No senders blocked or always allowed.</p> : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${rule.rule === "block" ? "bg-red-500/10 text-red-300" : "bg-emerald-500/10 text-emerald-300"}`}>{rule.rule === "block" ? "Blocked" : "Always allowed"}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{senderLabel(rule.channel, rule.senderId, rule.senderName)} <span className="text-xs text-muted-foreground">· {channelLabel[rule.channel] ?? rule.channel} · since {formatDateTime(rule.updatedAt)}</span></span>
                {canReview && <SaveForm action={clearSenderRule.bind(null, rule.id)}><SaveButton className="btn-secondary btn-sm" pendingLabel="Removing…">Remove</SaveButton></SaveForm>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Spam rules for everyone</h2><p className="mt-1 text-xs text-muted-foreground">Marking a message as spam only <b>suggests</b> a rule here. A rule holds matching messages from <b>any</b> sender, so it does nothing until an owner switches it on — and can be switched off again.</p></div>
        {patterns.length === 0 ? <p className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">No rules suggested yet.</p> : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {patterns.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className={`rounded-full px-2 py-0.5 text-[10px] ${p.status === "active" ? "bg-amber-500/10 text-amber-300" : "bg-muted text-muted-foreground"}`}>{p.status === "active" ? "On" : "Suggested"}</span>
                <span className="min-w-0 flex-1 text-xs"><span className="text-muted-foreground">{p.kind === "domain" ? "Links to: " : "Wording like: "}</span><span className="break-words">{inertPreview(p.value, 160)}</span> <span className="text-muted-foreground">· marked {p.hits}×</span></span>
                {isOwner && (
                  <SaveForm action={decideSpamPattern.bind(null, p.id, p.status === "active" ? "disabled" : "active")}>
                    <SaveButton className="btn-secondary btn-sm" pendingLabel="Saving…">{p.status === "active" ? "Switch off" : "Switch on"}</SaveButton>
                  </SaveForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-3"><h2 className="text-sm font-semibold">Last {metrics.days} days</h2><p className="mt-1 text-xs text-muted-foreground">Counts of what happened. They are not an accuracy score: only {metrics.reviewed} of {metrics.screened} screened messages have been checked by a person.</p></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Screened", value: metrics.screened, detail: "Messages the filter looked at" },
            { label: "Held", value: metrics.quarantined, detail: `${pct(metrics.quarantined, metrics.screened)} of screened` },
            { label: "Restored as genuine", value: metrics.restoredAsGenuine, detail: "Held, then a person said not spam" },
            { label: "Missed", value: metrics.missedMarkedByStaff, detail: "Let through, then marked spam by a person" },
            { label: "Notifications not sent", value: metrics.suppressedPushes, detail: "One per held message" },
            { label: "Chatbot runs not started", value: metrics.suppressedBotRuns, detail: `Also ${metrics.suppressedNewContacts} contacts and ${metrics.suppressedNewLeads} leads not created` },
            { label: "AI checks", value: metrics.aiCalls, detail: `${metrics.aiInputTokens.toLocaleString("en-ZA")} in / ${metrics.aiOutputTokens.toLocaleString("en-ZA")} out tokens · ${metrics.failures} failed` },
            { label: "Time to decide", value: metrics.medianLatencyMs === null ? "—" : `${metrics.medianLatencyMs} ms`, detail: metrics.p95LatencyMs === null ? "Median" : `Median · 95% under ${metrics.p95LatencyMs} ms` },
          ].map((stat) => (
            <Surface key={stat.label} className="p-4"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{stat.value}</p><p className="mt-1 text-[11px] text-muted-foreground">{stat.detail}</p></Surface>
          ))}
        </div>
      </section>

      {isOwner && (
        <section>
          <div className="mb-3"><h2 className="text-sm font-semibold">Filter settings</h2><p className="mt-1 text-xs text-muted-foreground">Owner only. Changes are recorded in the audit trail.</p></div>
          <Surface className="p-4">
            <SaveForm action={saveScreeningSettings} resetOnSuccess={false} className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium">Mode</legend>
                {([["off", "Off", "Every message is handled as it always was."], ["observe", "Observe only", "Judge and record, but hold nothing and change nothing."], ["quarantine", "Quarantine", "Hold confirmed spam and blocked senders out of the inbox."]] as const).map(([value, label, hint]) => (
                  <label key={value} className="flex items-start gap-2 text-sm"><input type="radio" name="mode" value={value} defaultChecked={mode === value} className="mt-1" /><span>{label}<span className="block text-xs text-muted-foreground">{hint}</span></span></label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="text-xs">May the AI check hold a message by itself?
                  <select name="aiQuarantine" defaultValue={policy.aiQuarantine} className="input mt-1"><option value="strong">Yes — only clear scams, when it is sure</option><option value="never">No — only my rules and blocks hold messages</option></select>
                </label>
                <label className="text-xs">“Same as known spam” match (0.6–1)<input name="repeatSimilarity" type="number" step="0.05" min="0.6" max="1" defaultValue={policy.repeatSimilarity} className="input mt-1" /></label>
                <label className="text-xs">Shortest message matched as a repeat (words)<input name="repeatMinWords" type="number" min="4" max="30" defaultValue={policy.repeatMinWords} className="input mt-1" /></label>
                <label className="text-xs">Burst: same message this many times<input name="burstCount" type="number" min="3" max="100" defaultValue={policy.burstCount} className="input mt-1" /></label>
                <label className="text-xs">…within (seconds)<input name="burstWindowSeconds" type="number" min="10" max="3600" defaultValue={policy.burstWindowSeconds} className="input mt-1" /></label>
                <label className="text-xs">AI checks per sender, per hour<input name="aiPerSenderPerHour" type="number" min="0" max="50" defaultValue={policy.aiPerSenderPerHour} className="input mt-1" /></label>
                <label className="text-xs">AI checks per day, whole workspace<input name="aiPerWorkspacePerDay" type="number" min="0" max="20000" defaultValue={policy.aiPerWorkspacePerDay} className="input mt-1" /></label>
                <label className="text-xs">AI check time limit (ms)<input name="aiTimeoutMs" type="number" min="1000" max="15000" step="500" defaultValue={policy.aiTimeoutMs} className="input mt-1" /></label>
              </div>
              <SaveButton className="btn-primary btn-sm" pendingLabel="Saving…">Save filter settings</SaveButton>
            </SaveForm>
          </Surface>
        </section>
      )}
    </div>
  );
}
