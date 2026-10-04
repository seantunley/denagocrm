"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Copy, Loader2, X } from "lucide-react";
import { runAssistantAction } from "@/app/actions/assistant";
import type { ActionCard } from "@/lib/assistantActions";

/**
 * One proposed task. Nothing happens until Confirm — and then it runs through
 * the same action a person would use by hand. A message draft is never sent
 * from here: Copy it, open the lead, send it from the conversation.
 */
export default function AssistantActionCard({ card }: { card: ActionCard }) {
  const [state, setState] = useState<"open" | "done" | "dismissed">("open");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (state === "dismissed") return null;

  const confirm = () =>
    startTransition(async () => {
      const result = await runAssistantAction(card).catch(() => ({ ok: false, error: "Couldn't reach the server — try again." }));
      setMessage(result.ok ? ("success" in result && result.success) || "Done" : result.error ?? "That didn't work.");
      if (result.ok) setState("done");
    });

  const copy = async () => {
    const text = card.kind === "draft_message" ? [card.subject, card.body].filter(Boolean).join("\n\n") : "";
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Copied — paste it into the conversation and send it there.");
    } catch {
      setMessage("Couldn't copy — select the text and copy it yourself.");
    }
  };

  return (
    <div className={`rounded-lg border p-3 text-sm ${state === "done" ? "border-emerald-500/40" : "border-border"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{card.title}</p>
          <Link href={`/leads/${card.leadId}`} className="text-xs text-muted-foreground hover:underline">{card.leadLabel}</Link>
        </div>
        {state === "open" && (
          <button type="button" onClick={() => setState("dismissed")} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        )}
      </div>
      {card.kind === "note" && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">{card.text}</p>}
      {card.kind === "draft_message" && (
        <div className="mt-2 rounded-md bg-muted/40 p-2 text-xs">
          {card.subject && <p className="font-medium">{card.subject}</p>}
          <p className="whitespace-pre-line">{card.body}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.kind === "draft_message" ? (
          <>
            <button type="button" onClick={copy} className="btn-secondary btn-sm inline-flex items-center gap-1">
              <Copy className="size-3.5" /> Copy
            </button>
            <Link href={`/leads/${card.leadId}`} className="btn-secondary btn-sm">Open lead</Link>
          </>
        ) : state === "open" ? (
          <button type="button" onClick={confirm} disabled={pending} className="btn-primary btn-sm inline-flex items-center gap-1">
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Confirm
          </button>
        ) : null}
        {message && <span className={`text-xs ${state === "done" || card.kind === "draft_message" ? "text-muted-foreground" : "text-destructive"}`}>{message}</span>}
      </div>
    </div>
  );
}
