"use client";

import { useState, useTransition } from "react";
import { BellOff } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { setLeadAttentionSnooze } from "@/app/actions/attention";
import { SNOOZE_DAYS } from "@/lib/attention/score";

/**
 * "Snooze" on one row of the Attention Centre.
 *
 * Deliberately not optimistic. The row DISAPPEARS on success, and an optimistic
 * removal that then failed would leave somebody believing they had dealt with a
 * deal they had not — the one outcome this whole screen exists to prevent. The
 * round trip is one indexed update; waiting for it costs nothing worth having.
 */
export default function SnoozeAttentionButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  return (
    <button
      type="button"
      className="btn-secondary btn-sm shrink-0"
      disabled={pending || done}
      onClick={() =>
        startTransition(async () => {
          const result = await setLeadAttentionSnooze(leadId, true).catch(() => ({
            ok: false as const,
            error: "Couldn't snooze this deal",
          }));
          if (!result.ok) {
            toast.error(result.error ?? "Couldn't snooze this deal");
            return;
          }
          setDone(true);
          toast.success(`Snoozed for ${SNOOZE_DAYS} days`);
          router.refresh();
        })
      }
    >
      <BellOff className="size-4" />
      {pending ? "Snoozing…" : `Snooze ${SNOOZE_DAYS}d`}
    </button>
  );
}
