"use client";

import { useState, useTransition } from "react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";

import { setUserRole, ownerResetUser2fa, setUserModules } from "@/app/actions/security";
import { MODULES } from "@/lib/access";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import type { ActionResult } from "@/lib/actionResultTypes";

/** Admin-only per-teammate controls: modules, role, 2FA reset. */
export default function OwnerUserControls({
  userId,
  name,
  role,
  modules,
  has2fa,
}: {
  userId: string;
  name: string;
  role: "owner" | "member";
  modules: string;
  has2fa: boolean;
}) {
  // The module checkboxes and the role toggle used to fire their action and
  // discard the promise: a rejection was swallowed whole and a success looked
  // identical to nothing happening. Both now report, and the checkbox reverts
  // when the save is refused so the UI never shows a permission that isn't set.
  const [active, setActive] = useState(
    () => new Set(modules.split(",").map((m) => m.trim()).filter(Boolean)),
  );
  const [pending, startTransition] = useTransition();

  const report = (run: () => Promise<ActionResult>, fallback: string, onRefused?: () => void) =>
    startTransition(async () => {
      try {
        const result = await run();
        if (result?.error) {
          toast.error(result.error);
          onRefused?.();
          return;
        }
        toast.success(result?.success ?? fallback);
      } catch (error) {
        unstable_rethrow(error);
        toast.error("Something went wrong. Please try again.");
        onRefused?.();
      }
    });

  return (
    <div className="flex flex-col items-end gap-1.5">
      {role === "member" && (
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {MODULES.map((m) => (
            <label
              key={m.id}
              title={m.desc}
              className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer"
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={active.has(m.id)}
                disabled={pending}
                onChange={(e) => {
                  const before = active;
                  const next = new Set(before);
                  if (e.target.checked) next.add(m.id);
                  else next.delete(m.id);
                  setActive(next);
                  report(
                    () => setUserModules(userId, [...next].join(",")),
                    "Modules updated.",
                    () => setActive(before),
                  );
                }}
              />
              {m.label}
            </label>
          ))}
        </div>
      )}
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
