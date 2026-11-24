"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setQuoteStatus } from "@/app/actions/quotes";

/**
 * "Mark accepted" on the deal page. Accepting is consequential — it wins the
 * lead and puts the deal on Deliveries (setQuoteStatus → acceptQuoteInTx) — so it
 * asks once more before doing it, and says what it did only once the server has.
 */
export default function MarkAcceptedButton({ quoteId, number, className = "btn-secondary" }: { quoteId: string; number: number; className?: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    try {
      const result = await setQuoteStatus(quoteId, "accepted");
      if (result && "error" in result && result.error) toast.error(result.error);
      else {
        toast.success(result && "success" in result && result.success ? result.success : `Q-${number} accepted`);
        router.refresh();
      }
    } catch {
      toast.error("That didn't go through. Try again.");
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className={className} onClick={() => setConfirming(true)} title="The customer accepted another way (in person, by email). Wins the lead and puts the deal on Deliveries.">
        Mark accepted
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Accept Q-{number}? The lead is marked won.</span>
      <button type="button" className="btn-primary btn-sm" onClick={accept} disabled={pending}>{pending ? "Accepting…" : "Yes, accept"}</button>
      <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={pending}>Cancel</button>
    </span>
  );
}
