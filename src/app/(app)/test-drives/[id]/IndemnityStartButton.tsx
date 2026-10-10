"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { startTestDriveIndemnity } from "@/app/actions/testDriveIndemnity";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";

/**
 * "Sign indemnity on this device" / "Start again".
 *
 * Its own button, not a SaveForm, for one reason: a SaveForm toasts on success,
 * and the next screen is the DRIVER'S. A CRM toast must not follow the device
 * into their hands. So a refusal is said here, and success says nothing — the
 * button stays on "Preparing…" until the signing screen replaces this page.
 */
export function IndemnityStartButton({ bookingId, again }: { bookingId: string; again: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={again ? "btn-secondary btn-sm" : "btn-primary btn-sm"}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const result = await startTestDriveIndemnity(bookingId);
          if (!result.error && result.redirectTo) return router.push(result.redirectTo);
          toast.error(result.error ?? ACTION_NOT_DELIVERED);
        } catch {
          toast.error(ACTION_NOT_DELIVERED);
        }
        setPending(false);
      }}
    >
      {pending ? "Preparing…" : again ? "Start again" : "Sign indemnity on this device"}
    </button>
  );
}
