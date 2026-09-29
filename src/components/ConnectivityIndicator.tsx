"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, CloudOff, Loader2 } from "lucide-react";
import { offlinePendingCount, purgeChecklistDeviceData } from "@/lib/checklists/deviceStore";
import type { OfflineScope } from "@/lib/checklists/queue";
import { cn } from "@/lib/utils";

export default function ConnectivityIndicator({ tenantId, userId }: OfflineScope) {
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

  const label = syncing ? "Syncing" : online ? "Online" : "Offline";
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px] font-semibold",
        online
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-200",
      )}
      title={pending > 0 ? `${pending} change${pending === 1 ? "" : "s"} waiting to sync` : label}
      aria-live="polite"
    >
      {syncing ? <Loader2 className="size-3 animate-spin" /> : online ? <Cloud className="size-3" /> : <CloudOff className="size-3" />}
      <span>{label}</span>
      {pending > 0 && <span className="rounded-full bg-background/60 px-1 tabular-nums">{pending}</span>}
    </span>
  );
}
