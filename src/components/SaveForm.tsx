"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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

function messageFor(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Next.js uses thrown control-flow objects for redirect() and notFound().
  // Those are successful outcomes, not failures, and must never surface as one.
  if (/NEXT_REDIRECT|NEXT_NOT_FOUND/.test(raw)) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "Something went wrong. Please try again.";
  // Server actions are minified in production and can throw opaque digests.
  // Showing "Error: aBc123" helps nobody; say something true instead.
  if (/^[A-Za-z0-9_-]{6,}$/.test(trimmed) && !trimmed.includes(" ")) {
    return "Something went wrong. Please try again.";
  }
  return trimmed;
}

/** A result object an action may return instead of throwing. */
type ActionResult = { error?: string | null; success?: string | null } | void | undefined;

export function SaveForm({
  action,
  success = "Saved",
  children,
  className,
  onSaved,
  ...rest
}: {
  /** Server action. May return void, or `{ error }` to report a failure without throwing. */
  action: (formData: FormData) => Promise<ActionResult>;
  /** Toast shown when the action resolves without an error. */
  success?: string;
  children: ReactNode;
  className?: string;
  /** Optional client-side hook after a successful save (e.g. close a dialog). */
  onSaved?: () => void;
} & Omit<React.FormHTMLAttributes<HTMLFormElement>, "action" | "onSubmit">) {
  const [pending, setPending] = useState(false);

  return (
    <form
      {...rest}
      className={className}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return; // a second click must not fire a second save
        const formData = new FormData(event.currentTarget);
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
          onSaved?.();
        } catch (error) {
          const message = messageFor(error);
          // An empty message means redirect()/notFound() — a successful outcome
          // that throws by design. Rethrow so Next can perform the navigation.
          if (!message) throw error;
          toast.error(message);
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
