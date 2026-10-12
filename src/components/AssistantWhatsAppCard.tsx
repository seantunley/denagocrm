"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageCircle } from "lucide-react";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { setMyWhatsAppUpdates, startWhatsAppLink, unlinkMyWhatsApp, type WhatsAppLinkStart } from "@/app/actions/assistantWhatsApp";

/**
 * "DAX on WhatsApp" on the Ask page: link your OWN phone by sending a one-time
 * code from it. The code is shown once, here, and never stored in the clear.
 * `linked` is the masked number (last three digits) or null; `refused` is why
 * the last code sent did not link, or null. The phone is never told — the page
 * is, so "I've sent it" re-reads the link and shows what happened.
 */
export default function AssistantWhatsAppCard({ name, linked, refused, updates }: { name: string; linked: string | null; refused: string | null; updates: boolean }) {
  const router = useRouter();
  const [start, setStart] = useState<WhatsAppLinkStart | null>(null);
  const [checked, setChecked] = useState(false);
  const [pending, startTransition] = useTransition();

  const link = () =>
    startTransition(async () => {
      setChecked(false);
      setStart(await startWhatsAppLink());
      // Asking for a code clears the last refusal on the server; show that.
      router.refresh();
    });
  const check = () =>
    startTransition(() => {
      setChecked(true);
      router.refresh();
    });
  // The code panel stays until the code has had its answer: linked, or refused.
  const waiting = start?.ok && !linked && !refused;

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
      {linked && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 accent-primary"
            checked={updates}
            disabled={pending}
            onChange={(e) => {
              const on = e.target.checked;
              startTransition(async () => {
                await setMyWhatsAppUpdates(on);
                router.refresh();
              });
            }}
          />
          <span>
            <span className="block font-medium">Send my scheduled briefings and alerts to this phone too</span>
            <span className="block text-xs text-muted-foreground">
              They are always here in the CRM as well. WhatsApp only lets {name} write to you freely within 24 hours of
              your last message to the business number. After that you get a short &ldquo;you have an update&rdquo;
              message instead (if your workspace has set one up) — tap its button and everything that was waiting
              arrives. Anything older than a day stays in the CRM only.
            </span>
          </span>
        </label>
      )}
      {refused && !linked && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">
          {refused}
        </p>
      )}
      {start?.ok && waiting ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p>
            Send <span className="font-mono font-semibold">{start.text}</span> on WhatsApp to{" "}
            {start.number ? <span className="font-mono">{start.number}</span> : "the business WhatsApp number"} within{" "}
            {start.minutes} minutes, from the phone you want to link.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href={start.waLink} target="_blank" rel="noreferrer" className="btn-primary inline-flex h-9 items-center px-3 text-sm">
              Open WhatsApp with the code
            </a>
            <button type="button" className="btn-secondary inline-flex h-9 items-center gap-2 px-3 text-sm" disabled={pending} onClick={check}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              I&apos;ve sent it — check
            </button>
          </div>
          {checked && !pending && (
            <p role="status" className="text-xs text-muted-foreground">
              Not linked yet. Check that you sent the code exactly as shown, to the number above, then check again — or ask
              for a new code.
            </p>
          )}
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
