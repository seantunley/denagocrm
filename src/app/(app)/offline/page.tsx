"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useOffline } from "@/components/OfflineProvider";
import { listOfflineMutations, removeOfflineMutation, requeueOfflineMutation } from "@/lib/offlineClient";
import {
  NO_OFFLINE_CAPABILITIES,
  recoverableFields,
  recoveryText,
  requeueBase,
  type OfflineDescriptor,
  type OfflineMutation,
} from "@/lib/offlineTypes";
import { INSPECTION_STATUSES } from "@/lib/workshop-constants";
import PhotoUploadField from "@/components/PhotoUploadField";
import { PageHeader } from "@/components/page-header";

const tabs = ["Job cards", "Deliveries", "Pending"] as const;
type Tab = (typeof tabs)[number];

export default function OfflineWorkspacePage() {
  const offline = useOffline();
  const [tab, setTab] = useState<Tab>("Job cards");
  const [entries, setEntries] = useState<OfflineMutation[]>([]);
  const queueLock = useRef(false);
  const [copied, setCopied] = useState<string | null>(null);

  async function reloadEntries() {
    if (!offline.snapshot) return;
    setEntries(await listOfflineMutations(offline.snapshot.tenantId, offline.snapshot.userId));
  }

  useEffect(() => { void reloadEntries(); }, [offline.pending, offline.snapshot]);

  async function queue(event: FormEvent<HTMLFormElement>, operation: OfflineDescriptor) {
    event.preventDefault();
    if (queueLock.current) return;
    queueLock.current = true;
    const form = event.currentTarget;
    try {
      await offline.queue(operation, new FormData(form));
      form.reset();
      if (offline.online) await offline.syncNow();
    } finally {
      queueLock.current = false;
    }
  }

  const snapshot = offline.snapshot;
  /*
   * ONLY OFFER WHAT THE REPLAY WILL ACCEPT.
   *
   * Every queued change is eventually executed by the ordinary Server Action,
   * which does its own `requirePermission`. Rendering a form regardless meant a
   * user without the write permission was told "Saved on this device", watched
   * the form clear, and lost the work when the sync refused it — the Pending
   * list records that a `lead.create` was rejected, not what was typed into it.
   *
   * Falling back to NO_OFFLINE_CAPABILITIES rather than to permissive defaults
   * matters for a device holding a snapshot cached before `can` existed: the
   * honest answer there is "refresh and I will tell you", not "go ahead".
   */
  const can = snapshot?.can ?? NO_OFFLINE_CAPABILITIES;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Offline field workspace"
        description={offline.online ? "Connected. Cached field records and queued work are up to date." : "No connection. Work is stored on this device until synchronisation."}
      >
        <button type="button" className="btn-secondary btn-sm" disabled={!offline.online} onClick={() => void offline.refreshSnapshot()}>
          Refresh offline data
        </button>
      </PageHeader>

      <div className={`rounded-xl border px-4 py-3 text-sm ${offline.online ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200" : "border-amber-400/30 bg-amber-400/10 text-amber-100"}`}>
        <span className={`mr-2 inline-block size-2 rounded-full ${offline.online ? "bg-emerald-400" : "bg-amber-400"}`} />
        <strong>{offline.online ? "Online" : "Offline"}</strong>
        <span className="ml-2">{offline.pending} pending change{offline.pending === 1 ? "" : "s"}</span>
        {snapshot && <span className="ml-2 text-current/70">· downloaded {new Date(snapshot.capturedAt).toLocaleString("en-ZA")}</span>}
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {tabs.map((item) => (
          <button key={item} type="button" onClick={() => setTab(item)} className={item === tab ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>
            {item}{item === "Pending" && offline.pending ? ` (${offline.pending})` : ""}
          </button>
        ))}
      </div>

      {!snapshot ? (
        <div className="card text-sm text-muted-foreground">No offline dataset has been downloaded on this device. Connect once and choose Refresh offline data.</div>
      ) : (
        <>
          {tab === "Job cards" && (
            <div className="space-y-3">
              {!can.jobCardManage && (
                <div className="card text-sm text-muted-foreground">
                  Your role can view job cards but not change them. Notes, inspections and photos
                  are read-only on this device.
                </div>
              )}
              {snapshot.jobCards.map((job) => (
                <div key={job.id} className="card space-y-4">
                  <div><p className="font-semibold">Job #{job.number} · {job.vehicle}</p><p className="text-xs text-muted-foreground">{job.customer} · {job.status} · {job.description}</p></div>
                  {can.jobCardManage && (<>
                  <form className="space-y-2" onSubmit={(event) => void queue(event, { type: "jobcard.notes", recordId: job.id, baseVersion: job.updatedAt })}>
                    <textarea name="checkinNotes" className="input" defaultValue={job.checkinNotes ?? ""} placeholder="Check-in condition notes" />
                    <textarea name="checkoutNotes" className="input" defaultValue={job.checkoutNotes ?? ""} placeholder="Check-out condition notes" />
                    <button className="btn-secondary btn-sm w-full">Save notes on this device</button>
                  </form>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <form className="rounded-lg border border-border p-3" onSubmit={(event) => void queue(event, { type: "jobcard.photo", recordId: job.id })}>
                      <label className="mb-2 block text-xs font-semibold">Check-in photos</label>
                      <PhotoUploadField required className="block w-full text-xs text-muted-foreground" />
                      <button className="btn-secondary btn-sm mt-2 w-full">Queue check-in photos</button>
                    </form>
                    <form className="rounded-lg border border-border p-3" onSubmit={(event) => void queue(event, { type: "jobcard.photo", recordId: job.id, parentId: "checkout" })}>
                      <label className="mb-2 block text-xs font-semibold">Check-out photos</label>
                      <PhotoUploadField required className="block w-full text-xs text-muted-foreground" />
                      <button className="btn-secondary btn-sm mt-2 w-full">Queue check-out photos</button>
                    </form>
                  </div>
                  {job.inspectionItems.length > 0 && (
                    <div className="space-y-2 border-t border-border pt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Inspection checklist</p>
                      {job.inspectionItems.map((item) => (
                        <div key={item.id} className="rounded-lg border border-border p-3">
                          <p className="mb-2 text-sm font-medium">{item.label}</p>
                          <form className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]" onSubmit={(event) => void queue(event, { type: "jobcard.inspection", recordId: item.id, parentId: job.id, baseVersion: item.updatedAt })}>
                            <select name="status" className="input" defaultValue={item.status}>{INSPECTION_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select>
                            <input name="notes" className="input" defaultValue={item.notes ?? ""} placeholder="Inspection note" />
                            <button className="btn-secondary btn-sm">Queue update</button>
                          </form>
                          <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => void queue(event, { type: "inspection.photo", recordId: item.id, parentId: job.id, baseVersion: item.updatedAt })}>
                            <PhotoUploadField required name="file" maxPhotos={1} className="min-w-0 flex-1 text-xs text-muted-foreground" />
                            <button className="btn-secondary btn-sm">{item.hasPhoto ? "Replace photo" : "Queue photo"}</button>
                          </form>
                        </div>
                      ))}
                    </div>
                  )}
                  </>)}
                </div>
              ))}
            </div>
          )}

          {tab === "Deliveries" && (
            <div className="grid gap-3 md:grid-cols-2">
              {!can.deliveryManage && (
                <div className="card text-sm text-muted-foreground md:col-span-2">
                  Your role can view deliveries but not complete them. Handovers and photos are
                  read-only on this device.
                </div>
              )}
              {snapshot.deliveries.map((delivery) => (
                <div key={delivery.id} className="card">
                  <p className="font-semibold">Quote Q-{delivery.number}</p>
                  <p className="text-xs text-muted-foreground">{delivery.customer}{delivery.scheduledFor ? ` · ${new Date(delivery.scheduledFor).toLocaleString("en-ZA")}` : ""}</p>
                  {can.deliveryManage && (
                    <>
                      {/*
                        PHOTOS ONLY. Completing a delivery is a signature, and
                        markDelivered enforces scheduling, module entitlement and
                        permission before it will record one — rules a cached
                        snapshot cannot evaluate. Offline signing is deliberately
                        not part of this feature; the guided handover on the
                        deliveries board is where a delivery is completed.
                      */}
                      <form className="mt-3 border-t border-border pt-3" onSubmit={(event) => void queue(event, { type: "delivery.photo", recordId: delivery.id })}>
                        <label className="mb-2 block text-xs font-semibold">Delivery photos</label>
                        <PhotoUploadField required className="block w-full text-xs text-muted-foreground" />
                        <button className="btn-secondary btn-sm mt-2 w-full">Queue delivery photos</button>
                      </form>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "Pending" && (
            <div className="space-y-3">
              {/*
                WHAT WAS TYPED, not just what was attempted.

                Every refusal a replay can produce — no permission, a closed
                stage, a gated move, a module switched off, a deleted record, a
                conflict — used to end the same way: the form had already
                cleared, and this list showed the operation type and nothing
                else. The refusal was never the damage; the work existing
                nowhere afterwards was. The queue held these fields the whole
                time.
              */}
              {entries.length === 0 ? <div className="card text-sm text-muted-foreground">Nothing is waiting to synchronise.</div> : entries.map((entry) => {
                const fields = recoverableFields(entry);
                const requeue = requeueBase(entry, snapshot);
                const stuck = entry.status === "failed" || entry.status === "conflict";
                return (
                  <div key={entry.id} className="card space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold">{entry.operation.type}</p>
                        <p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString("en-ZA")} · {entry.status}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        stuck ? "bg-red-500/15 text-red-300" : "bg-muted text-muted-foreground"
                      }`}>{stuck ? "needs you" : "waiting"}</span>
                    </div>

                    {entry.error && (
                      <p className="rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-300">{entry.error}</p>
                    )}

                    {fields.length > 0 && (
                      <dl className="grid gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/20 p-3 text-xs sm:grid-cols-2">
                        {fields.map((field) => (
                          <div key={field.name} className="min-w-0">
                            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{field.name}</dt>
                            <dd className="break-words text-foreground">
                              {field.kind === "file" ? `📎 ${field.value}` : field.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(recoveryText(entry));
                            setCopied(entry.id);
                          } catch {
                            // A clipboard the browser refuses is not a dead end:
                            // the fields are on screen to be read either way.
                            setCopied(null);
                          }
                        }}
                      >
                        {copied === entry.id ? "Copied" : "Copy details"}
                      </button>
                      {stuck && (requeue.retryable ? (
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={async () => {
                            await requeueOfflineMutation(entry, requeue.baseVersion);
                            await reloadEntries();
                            // The badge and the sign-out guard read the shared
                            // count, and this screen writes the queue directly.
                            await offline.recount();
                            if (offline.online) await offline.syncNow();
                          }}
                        >
                          Try again
                        </button>
                      ) : (
                        <span className="self-center text-[11px] text-amber-200">
                          The record this belongs to is no longer on this device — copy the details and re-enter them online.
                        </span>
                      ))}
                      <button type="button" className="btn-secondary btn-sm ml-auto" onClick={async () => { await removeOfflineMutation(entry.id); await reloadEntries(); await offline.recount(); }}>Discard</button>
                    </div>
                  </div>
                );
              })}
              {offline.online && entries.length > 0 && <button type="button" className="btn-primary w-full" onClick={() => void offline.syncNow()}>Synchronise now</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
