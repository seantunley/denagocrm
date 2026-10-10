"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendRequest, resendRequest, voidRequest, remindRecipient, updateRecipientContact } from "@/app/actions/signhub";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";

/**
 * `closed` is decided by the server from the ONE definition of a closed request
 * (signing/statusPolicy.ts). This used to work it out here from two of the five
 * closed states, so a declined, rejected or expired request kept a Resend and a
 * Void that could only fail.
 */
export function SendVoidBar({ requestId, status, closed }: { requestId: string; status: string; closed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const isDraft = status === "draft";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!closed && (
        <button type="button" disabled={pending} className="btn-primary btn-sm"
          onClick={() => start(async () => {
            const r = isDraft ? await sendRequest(requestId) : await resendRequest(requestId);
            // An approval being asked for is a success with nobody to count.
            const sent = r.message ?? `Sent to ${r.notified} recipient(s).`;
            setMsg(r.ok ? sent : r.error ?? "Failed");
            router.refresh();
          })}>
          {isDraft ? "Send for signing" : "Resend"}
        </button>
      )}
      {!closed && (
        <ConfirmActionDialog
          trigger={<button type="button" disabled={pending} className="btn-secondary btn-sm">Void</button>}
          title="Void signing request?"
          description="Recipients will no longer be able to sign this request, and a quote it had marked as sent goes back to draft. The audit record will remain available."
          confirmLabel="Void request"
          destructive
          onConfirm={async () => { await voidRequest(requestId); router.refresh(); }}
        />
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
  const [msg, setMsg] = useState<string | null>(null);
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
        onClick={() => start(async () => {
          // Say what happened. A reminder that reached nobody — no address on
          // file, not their turn yet — used to look exactly like one that went.
          const r = await remindRecipient(recipientId);
          setMsg(r.ok ? "Reminder sent." : r.error ?? "The reminder was not sent.");
          router.refresh();
        })}>Remind</button>
      <Link href={inPersonHref} className="btn-secondary btn-sm">✍ Sign in person</Link>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </div>
  );
}
