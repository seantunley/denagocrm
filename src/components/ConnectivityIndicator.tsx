"use client";

import { useCallback, useEffect, useState } from "react";
import { offlinePendingCount, purgeChecklistDeviceData } from "@/lib/checklists/deviceStore";
import type { OfflineScope } from "@/lib/checklists/queue";
import { cn } from "@/lib/utils";

/**
 * Whether the app can reach the server, and what this device still holds.
 *
 * Shown as a small dot on the person's avatar (Sean, 2026-11-12: the "Online"
 * badge replaced by option 2) — green when online, amber when offline, a
 * pulsing ring while saved work is uploading or still waiting — with the same
 * state spelled out at the top of the account menu (connectivityText).
 */
export type Connectivity = { online: boolean; pending: number; syncing: boolean };

export function useConnectivity({ tenantId, userId }: OfflineScope): Connectivity {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const refresh = useCallback(async () => {
    setOnline(navigator.onLine);
    setPending(await offlinePendingCount({ tenantId, userId }));
  }, [tenantId, userId]);

  useEffect(() => {
    void purgeChecklistDeviceData({ tenantId, userId }).then(refresh);
    const state = (event: Event) => {
      const detail = (event as CustomEvent<{ syncing?: boolean }>).detail;
      if (typeof detail?.syncing === "boolean") setSyncing(detail.syncing);
      void refresh();
    };
    window.addEventListener("online", state);
    window.addEventListener("offline", state);
    window.addEventListener("denago:offline-state", state);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.removeEventListener("online", state);
      window.removeEventListener("offline", state);
      window.removeEventListener("denago:offline-state", state);
      window.clearInterval(timer);
    };
  }, [refresh, tenantId, userId]);

  return { online, pending, syncing };
}

/** The state in words — the dot's tooltip, the account button's label and the menu's status line. */
export function connectivityText({ online, pending, syncing }: Connectivity): string {
  const waiting = pending > 0 ? `${pending} change${pending === 1 ? "" : "s"} waiting to sync` : "";
  if (!online) return waiting ? `Offline — ${waiting}, saved on this device` : "Offline — work is saved on this device";
  if (syncing) return waiting ? `Syncing — ${waiting}` : "Syncing";
  return waiting ? `Online — ${waiting}` : "Online — everything saved";
}

/** The dot, sitting on the avatar's lower-right edge. A ring pulses while work is uploading or waiting. */
export default function ConnectivityDot({ state }: { state: Connectivity }) {
  const busy = state.syncing || (state.online && state.pending > 0);
  return (
    <span aria-hidden title={connectivityText(state)} className="pointer-events-none absolute -bottom-0.5 -right-0.5 grid size-3 place-items-center">
      {busy && <span className="absolute inset-0 rounded-full bg-emerald-400/60 motion-safe:animate-ping" />}
      <span
        className={cn(
          "relative size-2.5 rounded-full ring-2 ring-sidebar-accent",
          state.online ? "bg-emerald-400" : "bg-amber-400",
        )}
      />
    </span>
  );
}
