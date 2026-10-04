"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageCircle } from "lucide-react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { startWhatsAppLink, unlinkMyWhatsApp, type WhatsAppLinkStart } from "@/app/actions/assistantWhatsApp";

/**
 * "DAX on WhatsApp" on the Ask page: link your OWN phone by sending a one-time
 * code from it. The code is shown once, here, and never stored in the clear.
 * `linked` is the masked number (last three digits) or null.
 */
export default function AssistantWhatsAppCard({ name, linked }: { name: string; linked: string | null }) {
  const [start, setStart] = useState<WhatsAppLinkStart | null>(null);
  const [pending, startTransition] = useTransition();

  const link = () =>
    startTransition(async () => {
      setStart(await startWhatsAppLink());
    });

  return (
    <section className="card space-y-3 p-5 text-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <MessageCircle className="h-4 w-4" aria-hidden /> {name} on WhatsApp
      </h2>
      <p className="text-muted-foreground">
        Ask {name} from your own phone by WhatsApping the business number. Answers can include customer details, so
        only link a phone that is yours.
      </p>
      {linked && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            Linked: <span className="font-mono">{linked}</span>
          </span>
          <ConfirmActionDialog
            trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Unlink</button>}
            title="Unlink your WhatsApp?"
            description={`${name} will stop answering messages from that phone.`}
            confirmLabel="Unlink"
            destructive
            onConfirm={unlinkMyWhatsApp}
          />
        </div>
      )}
      {start?.ok ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p>
            Send <span className="font-mono font-semibold">{start.text}</span> on WhatsApp to{" "}
            {start.number ? <span className="font-mono">{start.number}</span> : "the business WhatsApp number"} within{" "}
            {start.minutes} minutes, from the phone you want to link.
          </p>
          <a href={start.waLink} target="_blank" rel="noreferrer" className="btn-primary inline-flex h-9 items-center px-3 text-sm">
            Open WhatsApp with the code
          </a>
          <p className="text-xs text-muted-foreground">
            Send it from your own phone and never share the code — whoever sends it gets your answers. A new code replaces any phone
            linked before, and a number saved on a customer record can&apos;t be linked.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button type="button" className="btn-primary inline-flex h-9 items-center gap-2 px-3 text-sm" disabled={pending} onClick={link}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {linked ? "Link a different phone" : "Link my WhatsApp"}
          </button>
          {start && !start.ok && <span className="text-xs text-destructive">{start.error}</span>}
        </div>
      )}
    </section>
  );
}
