"use client";

import { useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";

import { setUserRole, ownerResetUser2fa } from "@/app/actions/security";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import type { ActionResult } from "@/lib/actionResultTypes";

/**
 * Admin-only per-teammate controls: role and 2FA reset.
 *
 * The per-user "modules" checkboxes are gone. They wrote `User.modules`, a
 * second authorization system the RBAC screens never read — ticking a permission
 * in /settings/access left the user bounced by the proxy, and un-ticking a
 * module here revoked access that /settings/access still showed as granted.
 * Access is granted in Settings → Access (roles and permissions) only.
 */
export default function OwnerUserControls({
  userId,
  name,
  role,
  has2fa,
}: {
  userId: string;
  name: string;
  role: "owner" | "member";
  has2fa: boolean;
}) {
  // The role toggle used to fire its action and discard the promise: a rejection
  // was swallowed whole and a success looked identical to nothing happening. It
  // now reports either way.
  const [pending, startTransition] = useTransition();

  const report = (run: () => Promise<ActionResult>, fallback: string) =>
    startTransition(async () => {
      try {
        const result = await run();
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(result?.success ?? fallback);
      } catch (error) {
        unstable_rethrow(error);
        toast.error("Something went wrong. Please try again.");
      }
    });

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const next = role === "owner" ? "member" : "owner";
            report(() => setUserRole(userId, next), `${name} is now ${next === "owner" ? "an admin" : "a member"}.`);
          }}
          className="text-xs text-slate-400 hover:text-orange-400 underline cursor-pointer disabled:opacity-50"
        >
          {role === "owner" ? "Make member" : "Make admin"}
        </button>
        {has2fa && (
          <ConfirmActionDialog
            destructive
            title={`Reset 2FA for ${name}?`}
            description="They will be signed out and will use only their password until two-factor authentication is configured again."
            confirmLabel="Reset 2FA"
            onConfirm={() => ownerResetUser2fa(userId)}
            trigger={<button type="button" className="cursor-pointer text-xs text-muted-foreground underline hover:text-red-400">Reset 2FA</button>}
          />
        )}
      </div>
    </div>
  );
}
