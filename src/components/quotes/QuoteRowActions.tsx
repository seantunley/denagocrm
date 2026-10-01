"use client";

import { useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { cancelQuote, duplicateQuote } from "@/app/actions/quotes";
import ConfirmDelete from "@/components/ConfirmDelete";
import { cancelQuoteConsequences, useOptionalQuoteEditor } from "@/components/quotes/QuoteEditorDialog";
import { cn } from "@/lib/utils";

/**
 * Cancel and Duplicate for one quote, wherever quotes are listed. The server
 * actions re-check permission and state; the flags here only stop offering a
 * button whose only outcome is a refusal.
 */
export default function QuoteRowActions({
  quoteId,
  number,
  status,
  signed = false,
  canCancel,
  canDuplicate,
  className,
}: {
  quoteId: string;
  number: number;
  status: string;
  signed?: boolean;
  canCancel: boolean;
  canDuplicate: boolean;
  className?: string;
}) {
  const router = useRouter();
  const editor = useOptionalQuoteEditor();
  const [pending, start] = useTransition();
  const link = "text-xs text-slate-500 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

  function duplicate() {
    start(async () => {
      try {
        const result = await duplicateQuote(quoteId);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(result?.success ?? "Quote duplicated");
        const newId = result?.redirectTo?.split("edit=")[1];
        if (editor && newId) {
          editor.openEditor(newId);
          router.refresh();
        } else if (result?.redirectTo) {
          router.push(result.redirectTo);
        }
      } catch (error) {
        unstable_rethrow(error);
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <button
        type="button"
        className={link}
        onClick={duplicate}
        disabled={pending || !canDuplicate}
        title={canDuplicate ? `Copy Q-${number} into a new, unsigned draft` : "Your role can't create quotes."}
      >
        {pending ? "Duplicating…" : "Duplicate"}
      </button>
      {status !== "cancelled" && (
        <ConfirmDelete
          action={cancelQuote.bind(null, quoteId)}
          title={`Cancel quote Q-${number}?`}
          description={cancelQuoteConsequences(status, signed)}
          trigger="Cancel quote"
          triggerClass="text-xs text-slate-500 hover:text-red-400"
          confirmLabel="Cancel quote"
          dismissLabel="Keep quote"
          pendingLabel="Cancelling…"
          reasonLabel="Reason for cancelling"
          reasonPlaceholder="e.g. Customer changed their order, deal fell through"
          success={`Quote Q-${number} cancelled`}
          contentClassName="z-[110]"
          disabled={!canCancel}
          disabledReason="Your role can't change a quote's status."
        />
      )}
    </span>
  );
}
