"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * "Sign on this device": makes a document and opens the screen a CUSTOMER signs
 * on. Sends whatever the form around it holds (who is handing over, a
 * checklist) — or nothing, when it stands alone.
 *
 * Its own button, not a SaveForm's, for one reason: a SaveForm toasts on
 * success, and the next screen is the customer's. A CRM toast must not follow
 * the device into their hands. So a refusal is said here, and success says
 * nothing — the button stays on "Preparing…" until the signing screen replaces
 * this page.
 */
export function SignOnDeviceButton({ start, children, className, pendingLabel = "Preparing…" }: {
  /** Returns `{ redirectTo }` (the signing screen) or `{ error }`. */
  start: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  pendingLabel?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      onClick={async (event) => {
        const form = event.currentTarget.form;
        // A plain button skips the browser's own "required" check; ask for it.
        if (form && !form.reportValidity()) return;
        const formData = form ? new FormData(form) : new FormData();
        // Starting a signature never needs an upload the form may also hold.
        for (const [name, value] of [...formData.entries()]) if (value instanceof File) formData.delete(name);
        setPending(true);
        try {
          const result = await start(formData);
          if (!result.error && result.redirectTo) return router.push(result.redirectTo);
          toast.error(result.error ?? ACTION_NOT_DELIVERED);
        } catch {
          toast.error(ACTION_NOT_DELIVERED);
        }
        setPending(false);
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
