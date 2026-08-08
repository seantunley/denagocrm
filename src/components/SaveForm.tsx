"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import { useCloseModal } from "@/components/Modal";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";
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

/**
 * A THROWN server-action error never carries a usable message to the browser.
 *
 * Next.js replaces it with an opaque digest in production, so there is nothing
 * here worth showing — trying to render it would leak a build artefact like
 * `aBc123` or, worse in development, an internal database message.
 *
 * That is why the message is not taken from the error. It is not, however, why
 * it used to be "Something went wrong. Please try again.": a failure INSIDE the
 * action now returns as a value carrying its own log reference, so anything
 * still thrown here is a call that never arrived. ACTION_NOT_DELIVERED says that,
 * and says the thing that actually fixes it. See components/actionError.ts.
 */
/**
 * A THROWN redirect is NOT evidence of a successful save.
 *
 * This previously treated ANY thrown redirect as success, which was wrong in the
 * most damaging direction: the auth guards redirect too — an expired session to
 * /login, a revoked permission to /, denied record access to /leads — so a save
 * that never ran could still toast "Lead saved" and then throw the form away.
 *
 * Success navigation is now explicit: an action returns `{ redirectTo }` and the
 * client navigates. Anything that THROWS is either a framework signal to be
 * re-thrown untouched, or a genuine failure. `unstable_rethrow` is Next's own
 * predicate for that first case, and is used instead of matching the internal
 * digest strings — those markers change between versions, and a stale matcher
 * here would silently swallow a redirect or misreport a 404.
 */

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
  const router = useRouter();

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
          // SECRETS ARE CLEARED EVEN WHEN THE FORM IS NOT RESET.
          //
          // Settings forms EDIT, so they set resetOnSuccess={false} to keep showing
          // what was saved — but that left a just-typed SMTP password, IMAP
          // password or API token sitting in the input and in the DOM after the
          // save. Those fields are write-only by design (they render as
          // "•••••••• saved — leave blank to keep", never the stored value), so
          // clearing them restores exactly the state the page renders with.
          //
          // Done here rather than per form: a call site that forgets this leaks a
          // credential, and there is no reason any caller would want the opposite.
          for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
            input.value = "";
          }
          if (closeModalOnSuccess) closeModal();
          onSaved?.();
          // Navigate only when the ACTION said the save succeeded and named the
          // destination. Nothing here is inferred from a thrown redirect.
          const redirectTo =
            result && typeof result === "object" && "redirectTo" in result
              ? result.redirectTo
              : undefined;
          if (redirectTo) router.push(String(redirectTo));
        } catch (error) {
          // Framework signals (redirect, notFound, forbidden, unauthorized, and
          // the render-control errors) are rethrown untouched and NEVER reported
          // as a save. A guard redirect landing here means the mutation did not
          // run — silence plus navigation is the honest outcome.
          unstable_rethrow(error);
          toast.error(ACTION_NOT_DELIVERED);
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
