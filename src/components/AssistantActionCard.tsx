"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Copy, Loader2, Send, X } from "lucide-react";
import { runAssistantAction, sendAssistantDraft } from "@/app/actions/assistant";
import type { ActionCard } from "@/lib/assistantActions";

/**
 * One proposed task. Nothing happens until Confirm — and then it runs through
 * the same action a person would use by hand. A message draft is shown in full
 * and can be changed; it goes to the customer ONLY when the person presses
 * Send, and the address it goes to is read again on the server.
 */
export default function AssistantActionCard({ card }: { card: ActionCard }) {
  const [state, setState] = useState<"open" | "done" | "dismissed">("open");
  const [message, setMessage] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const draft = card.kind === "draft_message" ? card : null;
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  // One per card: a second press after a dropped connection is the same message, not a second one.
  const [compositionId] = useState(() => `dax-${card.id}-${Math.random().toString(36).slice(2)}`);

  if (state === "dismissed") return null;

  const confirm = () =>
    startTransition(async () => {
      const result = await runAssistantAction(card).catch(() => ({ ok: false, error: "Couldn't reach the server — try again." }));
      setMessage(result.ok ? ("success" in result && result.success) || "Done" : result.error ?? "That didn't work.");
      if (result.ok) {
        setState("done");
        if ("href" in result && result.href) setHref(result.href);
      }
    });

  const send = () =>
    draft &&
    startTransition(async () => {
      const result = await sendAssistantDraft({ leadId: draft.leadId, channel: draft.channel, subject, body, compositionId })
        .catch(() => ({ ok: false, error: "Couldn't reach the server — check the conversation before trying again." }));
      setMessage(result.ok ? ("success" in result && result.success) || "Sent" : result.error ?? "That didn't send.");
      if (result.ok) setState("done");
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([subject, body].filter(Boolean).join("\n\n"));
      setMessage("Copied.");
    } catch {
      setMessage("Couldn't copy — select the text and copy it yourself.");
    }
  };

  const leadLink = card.kind === "schedule" || card.kind === "watch" ? null : card.leadId ? `/leads/${card.leadId}` : null;
  const editable = state === "open" && !pending;
  // Lost already renders its own "Reason:" line; don't double it.
  const reason = card.kind !== "lost" && "reason" in card && card.reason ? card.reason : null;

  return (
    <div className={`rounded-lg border p-3 text-sm ${state === "done" ? "border-emerald-500/40" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{card.kind === "schedule" ? `⏰ ${card.title}` : card.kind === "watch" ? `👀 ${card.title}` : card.title}</p>
          {card.kind === "schedule" ? (
            <p className="text-xs text-muted-foreground">Runs as you — manage it on the Ask page</p>
          ) : card.kind === "watch" ? (
            <p className="text-xs text-muted-foreground">Only ever tells you, never the customer — manage it on the Ask page</p>
          ) : leadLink ? (
            <Link href={leadLink} className="text-xs text-muted-foreground hover:underline">{card.leadLabel}</Link>
          ) : (
            <p className="text-xs text-muted-foreground">{card.leadLabel}</p>
          )}
          {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
        </div>
        {state === "open" && (
          <button type="button" onClick={() => setState("dismissed")} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        )}
      </div>
      {card.kind === "note" && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{card.text}</p>}
      {card.kind === "schedule" && <p className="mt-2 whitespace-pre-line text-xs">&ldquo;{card.question}&rdquo;</p>}
      {(card.kind === "meeting" || card.kind === "test_drive") && <p className="mt-1 text-xs text-muted-foreground">{card.detail}</p>}
      {card.kind === "lost" && <p className="mt-2 text-xs text-muted-foreground">Reason: {card.reason}</p>}
      {draft && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            To: {draft.to ?? <span className="text-destructive">no {draft.channel === "whatsapp" ? "number" : "address"} on file</span>} · goes out only when you press Send
          </p>
          {draft.channel === "email" && (
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={!editable}
              maxLength={150}
              placeholder="Subject"
              aria-label="Subject"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
            />
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={!editable}
            rows={Math.min(8, Math.max(3, body.split("\n").length + 1))}
            maxLength={4000}
            aria-label="Message"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs leading-relaxed"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {draft ? (
          <>
            {state === "open" && (
              <button
                type="button"
                onClick={send}
                disabled={pending || !draft.to || !body.trim() || (draft.channel === "email" && !subject.trim())}
                className="btn-primary btn-sm inline-flex items-center gap-1"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send {draft.channel === "whatsapp" ? "WhatsApp" : "email"}
              </button>
            )}
            <button type="button" onClick={copy} className="btn-secondary btn-sm inline-flex items-center gap-1">
              <Copy className="size-3.5" /> Copy
            </button>
          </>
        ) : state === "open" ? (
          <button type="button" onClick={confirm} disabled={pending} className="btn-primary btn-sm inline-flex items-center gap-1">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Confirm
          </button>
        ) : null}
        {href && <Link href={href} className="btn-secondary btn-sm">Open it</Link>}
        {message && <span className={`text-xs ${state === "done" || message === "Copied." ? "text-muted-foreground" : "text-destructive"}`}>{message}</span>}
      </div>
    </div>
  );
}
