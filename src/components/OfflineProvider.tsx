"use client";

import Link from "next/link";
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

export function useOffline() {
  const value = useContext(OfflineContext);
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
      const entries = await listOfflineMutations(tenantId, userId);
      for (const entry of entries) {
        if (mutationExpired(entry)) {
          await saveOfflineMutation({ ...entry, status: "failed", error: "Expired after 72 hours; review before retrying." });
          continue;
        }
        const working = { ...entry, status: "syncing" as const, attempts: entry.attempts + 1, error: undefined };
        await saveOfflineMutation(working);
        try {
          const response = await fetch("/api/offline/sync", { method: "POST", body: mutationBody(working) });
          const result = await response.json().catch(() => ({})) as { error?: string; conflict?: boolean };
          if (response.ok) {
            await removeOfflineMutation(entry.id);
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
      {(!online || pending > 0) && (
        <div className="fixed bottom-3 left-3 right-3 z-[80] mx-auto flex max-w-xl items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-slate-950/95 px-4 py-3 text-xs text-slate-200 shadow-2xl backdrop-blur">
          <div>
            <p className="font-semibold">{online ? (syncing ? "Synchronising field work…" : `${pending} change${pending === 1 ? "" : "s"} waiting`) : "Working offline"}</p>
            <p className="text-slate-400">{online ? "Keep this screen open until syncing finishes." : "Changes stay on this device until you reconnect."}</p>
          </div>
          <Link href="/offline" className="shrink-0 font-semibold text-orange-300 hover:text-orange-200">Open</Link>
        </div>
      )}
    </OfflineContext.Provider>
  );
}
