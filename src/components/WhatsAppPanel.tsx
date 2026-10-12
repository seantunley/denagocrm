"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import DealField from "@/components/DealField";
import type { DealOption } from "@/lib/customerTimeline";

type WaMessage = {
  id: string;
  direction: string | null;
  body: string;
  occurredAt: string; // ISO
  userName: string;
};

export default function WhatsAppPanel({
  phone,
  contactId,
  leadId,
  messages,
  configured,
  revalidate,
  deals = [],
}: {
  /** The customer's open deals, on a customer's page (lib/customerTimeline.dealChoice). */
  deals?: readonly DealOption[];
  phone: string | null;
  contactId?: string;
  leadId?: string;
  messages: WaMessage[];
  configured: boolean;
  revalidate: string;
}) {
  const [state, formAction, pending] = useActionState<WaState | undefined, FormData>(
    sendWhatsAppMessage,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * THE SEND KEY this box owes the server. sendWhatsAppMessage refuses a reply
   * without one ("missing its send key") — it is what lets a second press of
   * Send resolve to the message already queued instead of delivering it twice.
   * The inbox's reply box has supplied one since that rule was made; this box,
   * on the lead and customer pages, never did, so every send from it failed.
   *
   * One per composition, as InboxReply does it: made once the box is in the
   * browser (not while rendering — the server and the browser would disagree),
   * kept across a failed send so a retry is the same message, and replaced only
   * when a send is confirmed, so two identical replies stay two messages.
   */
  const [compositionId, setCompositionId] = useState<string>("");
  useEffect(() => {
    if (!compositionId) setCompositionId(crypto.randomUUID());
  }, [compositionId]);
  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    setCompositionId(crypto.randomUUID());
  }, [state]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  if (!phone) {
    return (
      <details className="card">
        <summary className="font-semibold cursor-pointer select-none">💬 WhatsApp</summary>
        <p className="text-sm text-slate-400 mt-3">No phone number on record.</p>
      </details>
    );
  }

  const waLink = `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "27")}`;

  return (
    <details className="card" open={messages.length > 0}>
      <summary className="font-semibold cursor-pointer select-none">
        💬 WhatsApp{" "}
        <span className="text-xs text-slate-500 font-normal">
          {messages.length > 0 ? `(${messages.length})` : ""}
        </span>
      </summary>

      <div ref={scrollRef} className="mt-4 max-h-80 overflow-y-auto space-y-2 pr-1">
        {messages.length === 0 && (
          <p className="text-sm text-slate-500">No WhatsApp messages yet.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${
              m.direction === "inbound"
                ? "bg-slate-800 text-slate-100 rounded-bl-sm"
                : "bg-emerald-900/70 text-emerald-50 ml-auto rounded-br-sm"
            }`}
          >
            {m.body}
            <p
              className={`text-[10px] mt-1 ${
                m.direction === "inbound" ? "text-slate-500" : "text-emerald-300/60"
              }`}
            >
              {m.direction === "inbound" ? "Customer" : m.userName} ·{" "}
              {new Date(m.occurredAt).toLocaleString("en-ZA", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          </div>
        ))}
      </div>

      {configured ? (
        <form ref={formRef} action={formAction} className="mt-3 flex flex-wrap gap-2 items-end">
          <input type="hidden" name="phone" value={phone} />
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
          {/* On a customer's page: which of their deals this is about (asked only when there are several). */}
          {!leadId && deals.length > 0 && <div className="w-full"><DealField deals={deals} id="whatsapp-deal" /></div>}
          <input type="hidden" name="revalidate" value={revalidate} />
          <input type="hidden" name="compositionId" value={compositionId} />
          <textarea
            name="text"
            rows={1}
            required
            placeholder="Type a WhatsApp message…"
            className="input flex-1"
          />
          {/* Not until the key exists: a send without it is refused. */}
          <button className="btn bg-emerald-700 text-white hover:bg-emerald-600" disabled={pending || !compositionId}>
            {pending ? "…" : "Send"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-slate-400 mt-3">
          Business WhatsApp isn&apos;t connected yet (
          <Link href="/settings/integrations" className="text-orange-400 hover:underline">
            Settings → Integrations
          </Link>
          ). Meanwhile:{" "}
          <a href={waLink} target="_blank" className="text-emerald-400 hover:underline">
            open chat in your WhatsApp →
          </a>
        </p>
      )}
      {state?.error && <p className="text-sm text-red-400 mt-2">{state.error}</p>}
    </details>
  );
}
