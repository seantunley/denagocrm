"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useCloseModal } from "@/components/Modal";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * A form that TELLS YOU WHAT HAPPENED.
 *
 * The problem this solves: a plain `<form action={serverAction}>` gives no
 * feedback at all. You click Save, the server action runs, the page revalidates,
 * and nothing visibly changes — so you cannot tell whether it worked, whether it
 * is still running, or whether it silently failed. Saving module grants in the
 * platform console was exactly this: the click looked inert.
 *
 * Two signals, because either alone is insufficient:
 *   - PENDING, on the button, immediately. This is what confirms the click
 *     registered. A toast that arrives 800ms later does not.
 *   - RESULT, as a toast. Success confirms it landed; failure says why.
 *
 * FAILURES STAY ON THE PAGE. Server actions here throw on refusal (a guard, a
 * unique violation, a suspended tenant). Left alone those hit the error boundary
 * and the whole page — including whatever was typed — is replaced by an error
 * screen. Catching them turns a lost page into a red toast and a form you can
 * correct and resubmit.
 *
 * WHY onSubmit RATHER THAN THE `action` PROP: React resets an uncontrolled form
 * after a form action completes. That is right after a successful save, and wrong
 * after a failed one — it would discard what the user typed at the exact moment
 * they need it. Owning submission keeps the fields intact so a retry is possible.
 * The cost is that these forms need JavaScript; every surface using them is an
 * authenticated React UI that already does.
 */

const PendingContext = createContext(false);

/** True while the enclosing <SaveForm> is submitting. */
export function useSavePending(): boolean {
  return useContext(PendingContext);
}

const GENERIC_FAILURE = "Something went wrong. Please try again.";

/**
 * A THROWN server-action error never carries a usable message to the browser.
 *
 * Next.js replaces it with an opaque digest in production, so there is nothing
 * here worth showing — trying to render it would leak a build artefact like
 * `aBc123` or, worse in development, an internal database message. Expected
 * refusals therefore travel as VALUES (`{ error }`, see lib/actionResult.ts) and
 * anything that reaches this function is by definition unexpected: it gets one
 * generic sentence, and the real detail stays in the server logs where it belongs.
 */
function isNextControlFlow(error: unknown): boolean {
  // redirect() and notFound() throw by design and are SUCCESSFUL outcomes.
  const raw = error instanceof Error ? error.message : String(error);
  const digest = (error as { digest?: unknown })?.digest;
  return (
    /NEXT_REDIRECT|NEXT_NOT_FOUND/.test(raw) ||
    (typeof digest === "string" && /NEXT_REDIRECT|NEXT_NOT_FOUND/.test(digest))
  );
}

/** A result object an action may return instead of throwing. */
/** Actions may also return nothing at all (a plain void action still works). */
type MaybeActionResult = ActionResult | void | undefined;

export function SaveForm({
  action,
  success = "Saved",
  children,
  className,
  onSaved,
  resetOnSuccess = true,
  closeModalOnSuccess = true,
  ...rest
}: {
  /** Server action. Returns `{ error }` for an expected refusal; throws only on a bug. */
  action: (formData: FormData) => Promise<MaybeActionResult>;
  /** Toast shown when the action resolves without an error. */
  success?: string;
  children: ReactNode;
  className?: string;
  /** Optional client-side hook after a successful save. */
  onSaved?: () => void;
  /**
   * Clear the fields after a successful save. ON by default: these forms create
   * things, and leaving the values in place both invites a duplicate submission
   * and — for the admin/tenant creation and password-reset forms — leaves a typed
   * PASSWORD sitting in a visible field.
   *
   * Turn OFF for forms that EDIT existing state (a settings panel, a checkbox
   * grid), where the fields should keep showing what was just saved rather than
   * snapping back to the values the page was rendered with.
   */
  resetOnSuccess?: boolean;
  /** Close the enclosing modal after a successful save. No-op outside a modal. */
  closeModalOnSuccess?: boolean;
} & Omit<React.FormHTMLAttributes<HTMLFormElement>, "action" | "onSubmit">) {
  const [pending, setPending] = useState(false);
  const closeModal = useCloseModal();

  return (
    <form
      {...rest}
      className={className}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return; // a second click must not fire a second save
        // Captured BEFORE awaiting: React nulls `currentTarget` once the handler
        // returns, so reaching for it after the await would throw.
        const form = event.currentTarget;
        const formData = new FormData(form);
        setPending(true);
        try {
          const result = await action(formData);
          if (result && typeof result === "object" && "error" in result && result.error) {
            toast.error(String(result.error));
            return;
          }
          const message =
            (result && typeof result === "object" && "success" in result && result.success) || success;
          toast.success(String(message));
          if (resetOnSuccess) form.reset();
          if (closeModalOnSuccess) closeModal();
          onSaved?.();
        } catch (error) {
          // redirect()/notFound() throw by design on success — let Next navigate.
          if (isNextControlFlow(error)) throw error;
          toast.error(GENERIC_FAILURE);
        } finally {
          setPending(false);
        }
      }}
    >
      <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
    </form>
  );
}

/**
 * Submit button that shows the enclosing form's pending state.
 *
 * Disabled while saving so an impatient second click cannot double-submit — the
 * failure mode a toast-only approach leaves wide open, since nothing about the
 * button changes until the save returns.
 */
export function SaveButton({
  children = "Save",
  pendingLabel,
  className,
  disabled,
  ...rest
}: {
  children?: ReactNode;
  /** Defaults to "Saving…". Give a verb that matches the button. */
  pendingLabel?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type">) {
  const pending = useSavePending();
  return (
    <button
      {...rest}
      type="submit"
      disabled={pending || disabled}
      aria-busy={pending}
      className={cn(className, pending && "cursor-wait opacity-70")}
    >
      {pending ? (pendingLabel ?? "Saving…") : children}
    </button>
  );
}
