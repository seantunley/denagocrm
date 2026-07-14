"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendRequest, voidRequest, remindRecipient, updateRecipientContact } from "@/app/actions/signhub";

export function SendVoidBar({ requestId, status }: { requestId: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const closed = status === "completed" || status === "voided";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!closed && (
        <button type="button" disabled={pending} className="btn-primary btn-sm"
          onClick={() => start(async () => { const r = await sendRequest(requestId); setMsg(r.ok ? `Sent to ${r.notified} recipient(s).` : r.error ?? "Failed"); router.refresh(); })}>
          {status === "draft" ? "Send for signing" : "Resend"}
        </button>
      )}
      {!closed && (
        <button type="button" disabled={pending} className="btn-secondary btn-sm"
          onClick={() => { if (confirm("Void this signing request? It can no longer be signed.")) start(async () => { await voidRequest(requestId); router.refresh(); }); }}>
          Void
        </button>
      )}
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}

export function RecipientControls({ recipientId, email: email0, phone: phone0, inPersonHref }: { recipientId: string; requestId: string; email: string; phone: string; inPersonHref: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState(email0);
  const [phone, setPhone] = useState(phone0);
  const dirty = email !== email0 || phone !== phone0;
  const inp = "h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground";

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <input className={inp} value={email} placeholder="email" onChange={(e) => setEmail(e.target.value)} />
      <input className={inp} value={phone} placeholder="phone (WhatsApp)" onChange={(e) => setPhone(e.target.value)} />
      {dirty && (
        <button type="button" disabled={pending} className="btn-secondary btn-sm"
          onClick={() => start(async () => { await updateRecipientContact(recipientId, { email, phone }); router.refresh(); })}>Save</button>
      )}
      <button type="button" disabled={pending} className="btn-secondary btn-sm"
        onClick={() => start(async () => { await remindRecipient(recipientId); router.refresh(); })}>Remind</button>
      <Link href={inPersonHref} className="btn-secondary btn-sm">✍ Sign in person</Link>
    </div>
  );
}
