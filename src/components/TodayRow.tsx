"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Mail, MessageSquare, Phone, X } from "lucide-react";
import { addCommunication } from "@/app/actions/communications";
import { sendEmailAction } from "@/app/actions/emails";
import { sendWhatsAppMessage } from "@/app/actions/whatsapp";
import { scheduleFollowUp } from "@/app/actions/activities";
import {
  CALL_OUTCOMES,
  callOutcomeLabel,
  textToEmailHtml,
  type ChannelState,
  type TodayChannel,
} from "@/lib/todayAction";
import { cn } from "@/lib/utils";

/** sendOutcomeMessage's answer for a confirmed send (lib/messageDelivery.ts — server-only, so not imported). */
const WHATSAPP_SENT = "Sent ✓";

const CHANNELS:{ key: TodayChannel; label: string; icon: typeof Phone }[] = [
  { key: "call", label: "Log a call", icon: Phone },
  { key: "whatsapp", label: "WhatsApp", icon: MessageSquare },
  { key: "email", label: "Email", icon: Mail },
];

/**
 * One Today row that DOES its action (lib/todayAction.ts). The button opens a composer
 * under the row with the deal's context filled in; one more click logs or sends,
 * books the next step and takes the row off the list. Every write goes through the
 * existing actions — addCommunication, sendEmailAction, sendWhatsAppMessage,
 * scheduleFollowUp — so their permission checks and send guards all still apply.
 * Nothing is sent until the rep presses the button.
 */
export default function TodayRow({
  leadId,
  action,
  channels,
  initialChannel,
  email,
  phone,
  drafts,
  nextStep,
  retryDate,
  children,
}: {
  leadId: string;
  action: string;
  channels: Record<TodayChannel, ChannelState>;
  initialChannel: TodayChannel;
  email: string | null;
  phone: string | null;
  drafts: { email: { subject: string; body: string }; whatsapp: string };
  /** Null when this person may not book activities: the panel then only logs or sends. */
  nextStep: { date: string; summary: string } | null;
  /** The next working day — where a call that reached nobody books its retry. */
  retryDate: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channel, setChannel] = useState<TodayChannel>(initialChannel);
  const [outcome, setOutcome] = useState<string>("reached");
  const [note, setNote] = useState("");
  const [waText, setWaText] = useState(drafts.whatsapp);
  const [subject, setSubject] = useState(drafts.email.subject);
  const [body, setBody] = useState(drafts.email.body);
  const [book, setBook] = useState(Boolean(nextStep));
  const [nextDate, setNextDate] = useState(nextStep?.date ?? "");
  const [nextSummary, setNextSummary] = useState(nextStep?.summary ?? "");
  // One send key per open composer: a double click resolves to the same WhatsApp, not two.
  const [compositionId] = useState(() => crypto.randomUUID());

  if (done) return null;
  const state = channels[channel];
  const id = `today-${leadId}`;

  function pickOutcome(value: string) {
    setOutcome(value);
    // Nobody reached: try again the next working day. A wrong number has no next call to book.
    if (value === "no_answer" || value === "voicemail") setNextDate(retryDate);
    else if (nextStep) setNextDate(nextStep.date);
    setBook(value !== "wrong_number" && Boolean(nextStep));
  }

  async function run() {
    if (!state.ok) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      let result: { ok?: string; error?: string; success?: string } | undefined;
      if (channel === "call") {
        const label = callOutcomeLabel(outcome);
        const form = new FormData();
        form.set("type", "call");
        form.set("direction", "outbound");
        form.set("subject", `Call — ${label.toLowerCase()}`);
        form.set("body", note.trim() || label);
        form.set("leadId", leadId);
        form.set("revalidate", "/today");
        result = await addCommunication(form);
      } else if (channel === "whatsapp") {
        const form = new FormData();
        form.set("phone", phone ?? "");
        form.set("text", waText);
        form.set("leadId", leadId);
        form.set("compositionId", compositionId);
        result = await sendWhatsAppMessage(undefined, form);
      } else {
        const form = new FormData();
        form.set("to", email ?? "");
        form.set("subject", subject);
        form.set("bodyHtml", textToEmailHtml(body));
        form.set("leadId", leadId);
        form.set("revalidate", "/today");
        result = await sendEmailAction(undefined, form);
      }
      if (!result || result.error) {
        setError(result?.error ?? "That didn't go through. Try again.");
        return;
      }
      // WhatsApp answers with the message's real delivery state. Anything short of
      // "Sent ✓" (e.g. "Queued — sending…") keeps the row: pressing again re-reads
      // the same message by its send key — it never sends twice.
      if (channel === "whatsapp" && result.ok !== WHATSAPP_SENT) {
        setNotice(`${result.ok ?? "Queued — sending…"} Not confirmed yet — press Send again to check; it won't send twice.`);
        return;
      }
      const did = channel === "call" ? "Call logged" : channel === "whatsapp" ? "WhatsApp sent" : "Email sent";
      if (book && nextDate) {
        const booked = await scheduleFollowUp({ leadId, type: "call", when: `${nextDate}T09:00`, summary: nextSummary.trim() || undefined });
        // The contact happened either way, so the row still leaves — but the missing booking is said out loud.
        if (!booked.ok) toast.error(`${did}, but the next step wasn't booked: ${booked.error ?? "unknown error"}`);
        else toast.success(`${did} · next step booked`);
      } else {
        toast.success(did);
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setPending(false);
    }
  }

  const button = channel === "call" ? "Log call" : "Send";
  return (
    <li className="card space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {children}
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {action}
          {open ? <X className="size-4" /> : <ArrowRight className="size-4" />}
        </button>
      </div>

      {open && (
        <div id={id} className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="How">
            {CHANNELS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={channel === key}
                onClick={() => { setChannel(key); setError(null); }}
                title={channels[key].ok ? undefined : channels[key].reason}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                  channel === key ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                  !channels[key].ok && "opacity-60",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          {!state.ok ? (
            <p className="text-sm text-muted-foreground">{state.reason}</p>
          ) : channel === "call" ? (
            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <div>
                <label htmlFor={`${id}-outcome`} className="label">Outcome</label>
                <select id={`${id}-outcome`} className="input" value={outcome} onChange={(event) => pickOutcome(event.target.value)}>
                  {CALL_OUTCOMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                {phone && <a href={`tel:${phone}`} className="mt-1.5 inline-block text-xs text-primary hover:underline">Call {phone}</a>}
              </div>
              <div>
                <label htmlFor={`${id}-note`} className="label">Notes (optional)</label>
                <textarea id={`${id}-note`} className="input" rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What was said?" />
              </div>
            </div>
          ) : channel === "whatsapp" ? (
            <div>
              <label htmlFor={`${id}-wa`} className="label">WhatsApp to {phone}</label>
              <textarea id={`${id}-wa`} className="input" rows={3} value={waText} onChange={(event) => setWaText(event.target.value)} />
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">To {email} · your email signature is added when it sends.</p>
              <div>
                <label htmlFor={`${id}-subject`} className="label">Subject</label>
                <input id={`${id}-subject`} className="input" value={subject} onChange={(event) => setSubject(event.target.value)} />
              </div>
              <div>
                <label htmlFor={`${id}-body`} className="label">Message</label>
                <textarea id={`${id}-body`} className="input" rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
              </div>
            </div>
          )}

          {state.ok && nextStep && (
            <div className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-orange-500" checked={book} onChange={(event) => setBook(event.target.checked)} />
                Book the next step
              </label>
              {book && (
                <>
                  <div>
                    <label htmlFor={`${id}-next-date`} className="label">On (09:00)</label>
                    <input id={`${id}-next-date`} type="date" className="input" value={nextDate} onChange={(event) => setNextDate(event.target.value)} />
                  </div>
                  <div className="min-w-48 flex-1">
                    <label htmlFor={`${id}-next-what`} className="label">What</label>
                    <input id={`${id}-next-what`} className="input" value={nextSummary} onChange={(event) => setNextSummary(event.target.value)} />
                  </div>
                </>
              )}
            </div>
          )}

          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          {notice && <p role="status" className="text-sm text-amber-500">{notice}</p>}

          {state.ok && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button type="button" className="btn-primary btn-sm" onClick={run} disabled={pending}>
                {pending ? "Working…" : book && nextStep ? `${button} & book next step` : button}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
