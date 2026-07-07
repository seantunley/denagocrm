"use client";

import { useActionState } from "react";
import { sendWhatsAppMessage, type WaState } from "@/app/actions/whatsapp";
import { sendDmReply, type DmState } from "@/app/actions/messenger";

/** Channel-aware reply box for the Social inbox. */
export default function InboxReply({
  channel,
  contactId,
  leadId,
  phone,
  revalidate,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  contactId?: string | null;
  leadId?: string | null;
  phone?: string | null;
  revalidate: string;
}) {
  const [waState, waAction] = useActionState<WaState | undefined, FormData>(
    sendWhatsAppMessage,
    undefined
  );
  const [dmState, dmAction] = useActionState<DmState | undefined, FormData>(
    sendDmReply,
    undefined
  );
  const state = channel === "whatsapp" ? waState : dmState;

  return (
    <form
      action={channel === "whatsapp" ? waAction : dmAction}
      className="flex items-start gap-2 mt-3"
    >
      {channel === "whatsapp" ? (
        <>
          <input type="hidden" name="phone" value={phone ?? ""} />
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
        </>
      ) : (
        <input type="hidden" name="contactId" value={contactId ?? ""} />
      )}
      <input type="hidden" name="revalidate" value={revalidate} />
      <textarea
        name="text"
        rows={1}
        required
        className="input flex-1"
        placeholder={`Reply via ${channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : "Messenger"}…`}
      />
      <button className="btn-primary btn-sm mt-1">Send</button>
      {state?.error && <p className="text-xs text-red-400 mt-2 max-w-56">{state.error}</p>}
      {state?.ok && <p className="text-xs text-emerald-400 mt-2">{state.ok}</p>}
    </form>
  );
}
