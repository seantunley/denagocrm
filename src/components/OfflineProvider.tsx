"use client";

import Link from "next/link";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  listOfflineMutations,
  loadOfflineSnapshot,
  mutationExpired,
  purgeOfflineData,
  queueOfflineMutation,
  removeOfflineMutation,
  saveOfflineMutation,
  saveOfflineSnapshot,
} from "@/lib/offlineClient";
import type { OfflineDescriptor, OfflineMutation, OfflineSnapshot } from "@/lib/offlineTypes";

type OfflineContextValue = {
  online: boolean;
  pending: number;
  syncing: boolean;
  queue: (operation: OfflineDescriptor, formData: FormData) => Promise<void>;
  syncNow: () => Promise<void>;
  snapshot: OfflineSnapshot | null;
  refreshSnapshot: () => Promise<void>;
};

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOptionalOffline() {
  return useContext(OfflineContext);
}

export function useOffline() {
  const value = useOptionalOffline();
  if (!value) throw new Error("useOffline must be used inside OfflineProvider");
  return value;
}

function mutationBody(entry: OfflineMutation): FormData {
  const body = new FormData();
  body.set("id", entry.id);
  body.set("tenantId", entry.tenantId);
  body.set("userId", entry.userId);
  body.set("operation", JSON.stringify(entry.operation));
  for (const field of entry.fields) {
    if (field.kind === "text") body.append(field.name, field.value);
    else body.append(field.name, field.value, field.fileName);
  }
  return body;
}

export default function OfflineProvider({
  tenantId,
  userId,
  children,
}: {
  tenantId: string;
  userId: string;
  children: ReactNode;
}) {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [snapshot, setSnapshot] = useState<OfflineSnapshot | null>(null);
  const syncLock = useRef(false);

  const recount = useCallback(async () => {
    setPending((await listOfflineMutations(tenantId, userId)).length);
  }, [tenantId, userId]);

  const refreshSnapshot = useCallback(async () => {
    if (!navigator.onLine) {
      setSnapshot(await loadOfflineSnapshot(tenantId, userId));
      return;
    }
    const response = await fetch("/api/offline/bootstrap", { cache: "no-store" });
    if (!response.ok) throw new Error("Offline field data could not be refreshed.");
    const next = await response.json() as OfflineSnapshot;
    if (next.tenantId !== tenantId || next.userId !== userId) {
      throw new Error("The offline snapshot did not match the active workspace.");
    }
    await saveOfflineSnapshot(next);
    setSnapshot(next);
  }, [tenantId, userId]);

  const syncNow = useCallback(async () => {
    if (!navigator.onLine || syncLock.current) return;
    syncLock.current = true;
    setSyncing(true);
    try {
      // A conflict or server refusal requires a person to review it. Replaying it
      // on every focus both destroys the useful first error and hammers a receipt
      // the server has deliberately closed as rejected.
      const entries = (await listOfflineMutations(tenantId, userId)).filter(
        (entry) => entry.status === "pending" || entry.status === "syncing",
      );
      for (const entry of entries) {
        if (mutationExpired(entry)) {
          await saveOfflineMutation({ ...entry, status: "failed", error: "Expired after 72 hours; review before retrying." });
          continue;
        }
        const working = { ...entry, status: "syncing" as const, attempts: entry.attempts + 1, error: undefined };
        await saveOfflineMutation(working);
        try {
          const response = await fetch("/api/offline/sync", { method: "POST", body: mutationBody(working) });
          const result = await response.json().catch(() => ({})) as { error?: string; conflict?: boolean; retry?: boolean };
          if (response.ok) {
            await removeOfflineMutation(entry.id);
          } else if (result.retry) {
            // Another tab or request owns this receipt. Leave it retryable so a
            // later pass can observe the completed receipt without replaying it.
            await saveOfflineMutation({
              ...working,
              status: "pending",
              error: result.error ?? "Another synchronisation is still processing this change.",
            });
            break;
          } else {
            await saveOfflineMutation({
              ...working,
              status: result.conflict ? "conflict" : "failed",
              error: result.error ?? "The server refused this offline change.",
            });
          }
        } catch {
          await saveOfflineMutation({ ...working, status: "pending", error: "Connection lost while synchronising." });
          break;
        }
      }
      await recount();
      await refreshSnapshot().catch(() => {});
    } finally {
      syncLock.current = false;
      setSyncing(false);
    }
  }, [recount, refreshSnapshot, tenantId, userId]);

  const queue = useCallback(async (operation: OfflineDescriptor, formData: FormData) => {
    await queueOfflineMutation(tenantId, userId, operation, formData);
    await recount();
    toast.success("Saved on this device — waiting to sync");
  }, [recount, tenantId, userId]);

  useEffect(() => {
    setOnline(navigator.onLine);
    void purgeOfflineData(tenantId, userId).then(async () => {
      await recount();
      setSnapshot(await loadOfflineSnapshot(tenantId, userId));
      if (navigator.onLine) await refreshSnapshot().catch(() => {});
    });
    const becameOnline = () => {
      setOnline(true);
      void syncNow();
    };
    const becameOffline = () => setOnline(false);
    const focused = () => navigator.onLine && void syncNow();
    window.addEventListener("online", becameOnline);
    window.addEventListener("offline", becameOffline);
    window.addEventListener("focus", focused);
    return () => {
      window.removeEventListener("online", becameOnline);
      window.removeEventListener("offline", becameOffline);
      window.removeEventListener("focus", focused);
    };
  }, [recount, refreshSnapshot, syncNow, tenantId, userId]);

  return (
    <OfflineContext.Provider value={{ online, pending, syncing, queue, syncNow, snapshot, refreshSnapshot }}>
      {children}
      <Link
        href="/offline"
        role="status"
        data-connectivity={syncing ? "syncing" : online ? "online" : "offline"}
        aria-label={syncing ? `Synchronising${pending ? `, ${pending} pending changes` : ""}` : online ? `Online${pending ? `, ${pending} pending changes` : ""}` : `Offline${pending ? `, ${pending} pending changes` : ""}`}
        className={`fixed bottom-20 right-3 z-[80] flex min-w-28 items-center justify-center gap-2 rounded-xl border-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide shadow-2xl transition-colors lg:bottom-4 ${
          syncing
            ? "border-sky-300 bg-sky-950 text-sky-100"
            : online
              ? "border-emerald-300 bg-emerald-950 text-emerald-100"
              : "border-orange-300 bg-orange-950 text-orange-50"
        }`}
      >
        {syncing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : online ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
        <span>{syncing ? "Syncing" : online ? "Online" : "Offline"}</span>
        {pending > 0 && <span className="rounded-full bg-black/25 px-1.5 py-0.5 tabular-nums">{pending}</span>}
      </Link>
    </OfflineContext.Provider>
  );
}
