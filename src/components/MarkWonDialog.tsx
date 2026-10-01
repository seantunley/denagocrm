"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { Check, Loader2, Trophy } from "lucide-react";
import { toast } from "sonner";
import { markWon, markWonChoices, type MarkWonChoices } from "@/app/actions/leads";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { formatZAR } from "@/lib/format";

/**
 * "Mark won", asked properly: WHICH quote did the customer accept?
 *
 * The answer decides whether the deal reaches Deliveries, so it is always an
 * explicit choice — never pre-selected, even with a single quote — and "won
 * without a quote" is its own option that says what it means.
 */
export function MarkWonForm({
  leadId,
  returnTo,
  onCancel,
  onWon,
}: {
  leadId: string;
  /** "/leads" keeps the person on the board instead of opening the customer. */
  returnTo?: "/leads";
  onCancel: () => void;
  onWon?: () => void;
}) {
  const router = useRouter();
  const [choices, setChoices] = useState<MarkWonChoices | null | "loading">("loading");
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    markWonChoices(leadId)
      .then((result) => live && setChoices(result))
      .catch(() => live && setChoices(null));
    return () => {
      live = false;
    };
  }, [leadId]);

  if (choices === "loading") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking this deal&apos;s quotes…</p>;
  }
  if (!choices) {
    return <p className="text-sm text-destructive">You can&apos;t mark this lead won, or it is no longer available.</p>;
  }

  const hasQuotes = choices.quotes.length > 0;
  const noQuoteNote = choices.acceptedNumbers.length > 0
    ? `Q-${choices.acceptedNumbers.join(", Q-")} is already accepted and on Deliveries.`
    : "Nothing goes to Deliveries until a quote is accepted.";

  function submit() {
    setError(null);
    const formData = new FormData();
    // With nothing to pick, "no quote" is what the person was shown and agreed to.
    formData.set("quoteId", hasQuotes ? picked : "none");
    if (returnTo) formData.set("returnTo", returnTo);
    start(async () => {
      try {
        const result = await markWon(leadId, formData);
        if (result?.error) {
          setError(result.error);
          return;
        }
        toast.success(result?.success ?? "Marked won");
        onWon?.();
        if (result?.redirectTo) router.push(result.redirectTo);
        else router.refresh();
      } catch (err) {
        unstable_rethrow(err);
        setError("Something went wrong. Please try again.");
      }
    });
  }

  const option = "flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-sm has-[:checked]:border-primary/60 has-[:checked]:bg-primary/5";

  return (
    <div className="space-y-3">
      {hasQuotes ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Which quote did the customer accept?</legend>
          {choices.quotes.map((quote) => (
            <label key={quote.id} className={option}>
              <input
                type="radio"
                name="won-quote"
                value={quote.id}
                checked={picked === quote.id}
                disabled={!choices.canAcceptQuotes || quote.outForSignature}
                onChange={() => setPicked(quote.id)}
                className="mt-0.5"
              />
              <span className="flex-1">
                Q-{quote.number} · {formatZAR(Math.round(quote.totalCents))}
                <span className="block text-xs text-muted-foreground">
                  {quote.outForSignature
                    ? "Out for signature — void the signing request first, or let the customer sign it."
                    : `Currently ${quote.status}. It is accepted and goes to Deliveries.`}
                </span>
              </span>
            </label>
          ))}
          <label className={option}>
            <input type="radio" name="won-quote" value="none" checked={picked === "none"} onChange={() => setPicked("none")} className="mt-0.5" />
            <span className="flex-1">
              Won without a quote
              <span className="block text-xs text-muted-foreground">{noQuoteNote}</span>
            </span>
          </label>
          {!choices.canAcceptQuotes && (
            <p className="text-xs text-muted-foreground">Your role can&apos;t accept quotes, so only &ldquo;won without a quote&rdquo; is available.</p>
          )}
        </fieldset>
      ) : (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          This lead has no open quote. It will be marked won, but {noQuoteNote.charAt(0).toLowerCase() + noQuoteNote.slice(1)}
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="button" onClick={submit} disabled={pending || (hasQuotes && !picked)}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
          Mark won
        </Button>
      </div>
    </div>
  );
}

export function MarkWonDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  returnTo,
  onWon,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  returnTo?: "/leads";
  onWon?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trophy className="size-4 text-emerald-400" />Mark {leadName} won?</DialogTitle>
          <DialogDescription>Closes the deal as won and links the customer — an existing one with the same email or phone is reused.</DialogDescription>
        </DialogHeader>
        {open && (
          <MarkWonForm
            leadId={leadId}
            returnTo={returnTo}
            onCancel={() => onOpenChange(false)}
            onWon={() => {
              onOpenChange(false);
              onWon?.();
            }}
          />
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}

/** The lead page's button: opens the dialog, lands on the customer when done. */
export default function MarkWonButton({ leadId, leadName }: { leadId: string; leadName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn bg-emerald-700 text-white hover:bg-emerald-600" onClick={() => setOpen(true)}>
        <Check className="size-4" />Mark won
      </button>
      <MarkWonDialog open={open} onOpenChange={setOpen} leadId={leadId} leadName={leadName} />
    </>
  );
}
