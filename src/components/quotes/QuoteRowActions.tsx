"use client";

import { useTransition } from "react";
import { useRouter, unstable_rethrow } from "next/navigation";
import { Download, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { cancelQuote, duplicateQuote } from "@/app/actions/quotes";
import ConfirmDelete from "@/components/ConfirmDelete";
import { cancelQuoteConsequences, useOptionalQuoteEditor } from "@/components/quotes/QuoteEditorDialog";
import QuoteEmailDialog from "@/components/quotes/QuoteEmailDialog";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ActionResult } from "@/lib/actionResultTypes";
import { cn } from "@/lib/utils";

/** The statuses whose common next step is to send the quote (again) or hand over its PDF. */
export const SEND_FROM_ROW = new Set(["sent", "accepted"]);

/**
 * A quote row's actions, wherever quotes are listed: the common path in view — Send and
 * Download PDF on a sent or accepted quote — and the rest (Duplicate, Cancel, Delete)
 * under More. The server actions re-check permission and state; the flags here only stop
 * offering a button whose only outcome is a refusal.
 */
export default function QuoteRowActions({
  quoteId,
  number,
  status,
  signed = false,
  emailed = false,
  canSend = false,
  canCancel,
  canDuplicate,
  deleteAction,
  canDelete = false,
  className,
}: {
  quoteId: string;
  number: number;
  status: string;
  signed?: boolean;
  /** Emailed before: Send says it goes again. */
  emailed?: boolean;
  /** quotes.change_status — the gate sendQuoteEmail itself applies. */
  canSend?: boolean;
  canCancel: boolean;
  canDuplicate: boolean;
  /** Bound deleteQuote; omitted where quotes can't be deleted from the list. */
  deleteAction?: (formData: FormData) => Promise<ActionResult | void>;
  canDelete?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const editor = useOptionalQuoteEditor();
  const [pending, start] = useTransition();
  const item = "rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
  const common = SEND_FROM_ROW.has(status);

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
    <span className={cn("inline-flex items-center gap-2", className)}>
      {common && canSend && <QuoteEmailDialog compact quoteId={quoteId} alreadyEmailed={emailed} onSent={() => router.refresh()} />}
      {common && (
        <a href={`/quotes/${quoteId}/pdf`} download className={buttonVariants({ variant: "outline", size: "sm" })} title={`Download Q-${number} as a PDF`}>
          <Download />PDF
        </a>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={buttonVariants({ variant: "ghost", size: "sm" })} aria-label={`More actions for Q-${number}`}>
            <MoreHorizontal />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-48 flex-col p-1.5">
          <button
            type="button"
            className={item}
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
              triggerClass={item}
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
          {deleteAction && (
            <ConfirmDelete
              action={deleteAction}
              title={`Delete quote Q-${number}?`}
              description="Moves the quote to Trash (restorable for 60 days)."
              trigger="Delete quote"
              triggerClass={`${item} text-red-400`}
              disabled={!canDelete}
              disabledReason="Your role can't delete quotes."
            />
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}
