"use client";

import { setUserRole, ownerResetUser2fa, setUserModules } from "@/app/actions/security";
import { MODULES } from "@/lib/access";

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
  const active = new Set(modules.split(",").map((m) => m.trim()).filter(Boolean));
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
                defaultChecked={active.has(m.id)}
                onChange={(e) => {
                  const next = new Set(active);
                  if (e.target.checked) next.add(m.id);
                  else next.delete(m.id);
                  setUserModules(userId, [...next].join(","));
                }}
              />
              {m.label}
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setUserRole(userId, role === "owner" ? "member" : "owner")}
          className="text-xs text-slate-400 hover:text-orange-400 underline cursor-pointer"
        >
          {role === "owner" ? "Make member" : "Make admin"}
        </button>
        {has2fa && (
          <button
            onClick={() => {
              if (
                confirm(
                  `Reset 2FA for ${name}? They'll sign in with just their password until they set it up again.`
                )
              ) {
                ownerResetUser2fa(userId);
              }
            }}
            className="text-xs text-slate-500 hover:text-red-400 underline cursor-pointer"
          >
            Reset 2FA
          </button>
        )}
      </div>
    </div>
  );
}
