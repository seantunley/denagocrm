"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";

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
}: {
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

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
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
        <form ref={formRef} action={formAction} className="mt-3 flex gap-2 items-end">
          <input type="hidden" name="phone" value={phone} />
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
          <input type="hidden" name="revalidate" value={revalidate} />
          <textarea
            name="text"
            rows={1}
            required
            placeholder="Type a WhatsApp message…"
            className="input flex-1"
          />
          <button className="btn bg-emerald-700 text-white hover:bg-emerald-600" disabled={pending}>
            {pending ? "…" : "Send"}
          </button>
        </form>
      ) : (
        <p className="text-sm text-slate-400 mt-3">
          Business WhatsApp isn&apos;t connected yet (
          <Link href="/settings?tab=integrations" className="text-orange-400 hover:underline">
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
