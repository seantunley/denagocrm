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
import {
  chainableSiblings,
  guardedRecordKey,
  type OfflineDescriptor,
  type OfflineMutation,
  type OfflineSnapshot,
} from "@/lib/offlineTypes";

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
      /*
       * CHAINED LOCAL EDITS ARE NOT CONFLICTS.
       *
       * Everything queued in one offline session carries the SAME downloaded
       * version — the notes and the inspection on a job card both hold the
       * job.updatedAt from the snapshot. Replaying the notes moves the record
       * on, so the inspection behind it looked stale and was rejected as "this
       * record changed while the device was offline": the device blaming a
       * third party for its own earlier edit, permanently, because a conflict
       * is never retried.
       *
       * The server now reports the version each accepted replay produced. It is
       * written straight onto the siblings still in the outbox, rather than held
       * only for this pass, so a sync interrupted halfway does not leave them
       * carrying a base version that no longer exists anywhere.
       *
       * REJECTIONS ADVANCE NOTHING. A refused change leaves its siblings on the
       * same base it was refused for, and they are refused too — which is right:
       * they were all authored against a version somebody else has moved.
       */
      async function advanceSiblings(after: OfflineMutation, key: string, version: string) {
        const queued = await listOfflineMutations(tenantId, userId);
        for (const sibling of chainableSiblings(after, queued, key, version)) {
          await saveOfflineMutation({
            ...sibling,
            operation: { ...sibling.operation, baseVersion: version },
          });
        }
      }

      for (const entry of entries) {
        if (mutationExpired(entry)) {
          await saveOfflineMutation({ ...entry, status: "failed", error: "Expired after 72 hours; review before retrying." });
          continue;
        }
        // Re-read: an earlier replay in this same pass may have advanced this
        // one's base version, and `entries` was listed before any of that.
        const stored = (await listOfflineMutations(tenantId, userId)).find((item) => item.id === entry.id) ?? entry;
        const working = { ...stored, status: "syncing" as const, attempts: stored.attempts + 1, error: undefined };
        await saveOfflineMutation(working);
        try {
          const response = await fetch("/api/offline/sync", { method: "POST", body: mutationBody(working) });
          const result = await response.json().catch(() => ({})) as { error?: string; conflict?: boolean; retry?: boolean; version?: string; indeterminate?: boolean };
          if (response.ok) {
            const key = guardedRecordKey(working.operation);
            if (key && result.version) await advanceSiblings(working, key, result.version);
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
          } else if (response.status === 401 || response.status === 403) {
            /*
             * NOT A REFUSAL OF THE WORK — a refusal of the CALLER.
             *
             * Connectivity often returns after a session has expired or been
             * revoked, and /api/offline/sync answers 401 before it claims a
             * receipt, so nothing was applied and nothing is decided. Marking
             * these `failed` stranded them permanently: a later pass only
             * selects `pending` or `syncing`, and the Pending list offers no way
             * back, so signing in again could not replay work that was never
             * refused on its merits.
             *
             * Left pending, and the pass STOPS: every remaining entry would meet
             * the same closed door, and walking the rest of the outbox would
             * burn an attempt on each.
             */
            await saveOfflineMutation({
              ...working,
              status: "pending",
              error: "Your session has expired. Sign in again and this will synchronise.",
            });
            break;
          } else {
            await saveOfflineMutation({
              ...working,
              status: result.conflict ? "conflict" : "failed",
              error: result.error ?? "The server refused this offline change.",
              // Carried so the Pending screen never offers to send it again --
              // see requeueBase.
              indeterminate: result.indeterminate === true,
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
    /*
     * TELL THE WORKER WHOSE DEVICE THIS IS.
     *
     * The cached /offline shell is server-rendered for one user and names them,
     * so serving it to the next person points the app at the first user's
     * IndexedDB partition. Sign-out clears it, but a session that simply EXPIRES
     * never runs sign-out — so the shell has to be invalidated by the arrival of
     * a different user instead.
     *
     * This provider sits in the authenticated layout, so it mounts on every page
     * a signed-in user renders: the new user announces themselves long before
     * they could ever reach /offline. Announcing from a page that was itself
     * served from the cached shell simply repeats the owner already stamped,
     * which is a no-op.
     */
    /*
     * REGISTER, THEN WAIT. `ready` never resolves on a device that has no root
     * registration yet — it waits for one rather than creating it — so waiting
     * on it alone meant the worker was only ever installed by PushToggle, which
     * lives on Settings. Anybody who followed the offline workspace flow without
     * first visiting Settings had no cached shell and no navigation fallback,
     * and discovered it at the moment they lost connectivity.
     *
     * Registering the same worker with the same scope as PushToggle is
     * idempotent: the browser returns the existing registration rather than
     * installing a second one.
     */
    void navigator.serviceWorker
      ?.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => navigator.serviceWorker.ready.then(() => registration))
      .then((registration) =>
        (registration.active ?? navigator.serviceWorker.controller)?.postMessage({
          type: "offline-shell-owner",
          owner: `${tenantId}:${userId}`,
        }),
      )
      .catch(() => {});

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
