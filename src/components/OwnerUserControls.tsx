"use client";

import { setUserRole, ownerResetUser2fa } from "@/app/actions/security";

/** Owner-only per-teammate controls: role toggle + 2FA reset. */
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
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => setUserRole(userId, role === "owner" ? "member" : "owner")}
        className="text-xs text-slate-400 hover:text-orange-400 underline cursor-pointer"
      >
        {role === "owner" ? "Make member" : "Make owner"}
      </button>
      {has2fa && (
        <button
          onClick={() => {
            if (confirm(`Reset 2FA for ${name}? They'll sign in with just their password until they set it up again.`)) {
              ownerResetUser2fa(userId);
            }
          }}
          className="text-xs text-slate-500 hover:text-red-400 underline cursor-pointer"
        >
          Reset 2FA
        </button>
      )}
    </div>
  );
}
