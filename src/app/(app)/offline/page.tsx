"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { useOffline } from "@/components/OfflineProvider";
import { listOfflineMutations, removeOfflineMutation } from "@/lib/offlineClient";
import type { OfflineDescriptor, OfflineMutation } from "@/lib/offlineTypes";
import { INSPECTION_STATUSES } from "@/lib/workshop-constants";
import PhotoUploadField from "@/components/PhotoUploadField";
import { PageHeader } from "@/components/page-header";

const tabs = ["Leads", "Contacts", "Job cards", "Deliveries", "Pending"] as const;
type Tab = (typeof tabs)[number];

export default function OfflineWorkspacePage() {
  const offline = useOffline();
  const [tab, setTab] = useState<Tab>("Job cards");
  const [entries, setEntries] = useState<OfflineMutation[]>([]);
  const queueLock = useRef(false);

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
          {tab === "Leads" && (
            <div className="space-y-4">
              <form className="card grid gap-3 sm:grid-cols-2" onSubmit={(event) => void queue(event, { type: "lead.create" })}>
                <h2 className="sm:col-span-2 font-semibold">New offline lead</h2>
                <input name="name" required className="input" placeholder="Customer name" />
                <input name="phone" className="input" placeholder="Phone" />
                <input name="email" type="email" className="input" placeholder="Email" />
                <select name="stageId" required className="input">
                  {snapshot.options.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                </select>
                <select name="productId" className="input"><option value="">Model undecided</option>{snapshot.options.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
                <input name="value" inputMode="decimal" className="input" placeholder="Estimated value (R)" />
                <input type="hidden" name="source" value="offline" />
                <input type="hidden" name="quantity" value="1" />
                <textarea name="notes" className="input sm:col-span-2" placeholder="Notes" />
                <button className="btn-primary sm:col-span-2">Save lead on this device</button>
              </form>
              <div className="grid gap-3 md:grid-cols-2">
                {snapshot.leads.map((lead) => (
                  <details key={lead.id} className="card">
                    <summary className="cursor-pointer"><span className="font-semibold">{lead.title}</span><span className="ml-2 text-sm text-muted-foreground">{lead.name} · {lead.stage}</span></summary>
                    <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={(event) => void queue(event, { type: "lead.update", recordId: lead.id, baseVersion: lead.updatedAt })}>
                      <input name="name" required className="input" defaultValue={lead.name} />
                      <input name="phone" className="input" defaultValue={lead.phone ?? ""} placeholder="Phone" />
                      <input name="email" type="email" className="input" defaultValue={lead.email ?? ""} placeholder="Email" />
                      <select name="stageId" className="input" defaultValue={lead.stageId}>{snapshot.options.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>
                      <select name="productId" className="input" defaultValue={lead.productId ?? ""}><option value="">Model undecided</option>{snapshot.options.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
                      <input name="value" className="input" inputMode="decimal" defaultValue={String(lead.valueCents / 100)} />
                      <input name="title" className="input sm:col-span-2" defaultValue={lead.title} />
                      <textarea name="notes" className="input sm:col-span-2" defaultValue={lead.notes ?? ""} />
                      <input type="hidden" name="source" value={lead.source} /><input type="hidden" name="color" value={lead.color ?? ""} /><input type="hidden" name="quantity" value={lead.quantity} /><input type="hidden" name="contactId" value={lead.contactId ?? ""} /><input type="hidden" name="assignedToId" value={lead.assignedToId ?? ""} />
                      <button className="btn-secondary btn-sm sm:col-span-2">Queue lead changes</button>
                    </form>
                  </details>
                ))}
              </div>
            </div>
          )}

          {tab === "Contacts" && (
            <div className="space-y-4">
              <form className="card grid gap-3 sm:grid-cols-2" onSubmit={(event) => void queue(event, { type: "contact.create" })}>
                <h2 className="sm:col-span-2 font-semibold">New offline contact</h2>
                <input name="firstName" required className="input" placeholder="First name / account name" />
                <input name="lastName" className="input" placeholder="Last name" />
                <input name="phone" className="input" placeholder="Phone" />
                <input name="whatsapp" className="input" placeholder="WhatsApp" />
                <input name="email" type="email" className="input sm:col-span-2" placeholder="Email" />
                <textarea name="notes" className="input sm:col-span-2" placeholder="Notes" />
                <button className="btn-primary sm:col-span-2">Save contact on this device</button>
              </form>
              <div className="grid gap-3 md:grid-cols-2">
                {snapshot.contacts.map((contact) => (
                  <details key={contact.id} className="card">
                    <summary className="cursor-pointer"><span className="font-semibold">{contact.name}</span><span className="ml-2 text-xs text-muted-foreground">{contact.phone ?? contact.whatsapp ?? contact.email ?? "No contact channel"}</span></summary>
                    {contact.fleetId ? <p className="mt-3 text-xs text-amber-200">Fleet membership changes require an online fleet lookup. Other downloaded details remain available for reference.</p> : (
                      <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={(event) => void queue(event, { type: "contact.update", recordId: contact.id, baseVersion: contact.updatedAt })}>
                        <input name="firstName" required className="input" defaultValue={contact.firstName} />
                        <input name="lastName" className="input" defaultValue={contact.lastName ?? ""} />
                        <input name="company" className="input" defaultValue={contact.company ?? ""} placeholder="Company" />
                        <input name="vatNumber" className="input" defaultValue={contact.vatNumber ?? ""} placeholder="VAT number" />
                        <input name="phone" className="input" defaultValue={contact.phone ?? ""} placeholder="Phone" />
                        <input name="whatsapp" className="input" defaultValue={contact.whatsapp ?? ""} placeholder="WhatsApp" />
                        <input name="email" type="email" className="input sm:col-span-2" defaultValue={contact.email ?? ""} placeholder="Email" />
                        <input name="address" className="input sm:col-span-2" defaultValue={contact.address ?? ""} placeholder="Address" />
                        <input name="suburb" className="input" defaultValue={contact.suburb ?? ""} placeholder="Suburb" />
                        <input name="city" className="input" defaultValue={contact.city ?? ""} placeholder="City" />
                        <input name="province" className="input" defaultValue={contact.province ?? ""} placeholder="Province" />
                        <input name="postalCode" className="input" defaultValue={contact.postalCode ?? ""} placeholder="Postal code" />
                        <textarea name="notes" className="input sm:col-span-2" defaultValue={contact.notes ?? ""} />
                        <input type="hidden" name="contactKind" value={contact.isCompany ? "business" : "individual"} /><input type="hidden" name="source" value={contact.source ?? ""} /><input type="hidden" name="ownerId" value={contact.ownerId ?? ""} /><input type="hidden" name="tags" value={contact.tags.join(", ")} />{contact.marketingOptOut && <input type="hidden" name="marketingOptOut" value="on" />}
                        <button className="btn-secondary btn-sm sm:col-span-2">Queue contact changes</button>
                      </form>
                    )}
                  </details>
                ))}
              </div>
            </div>
          )}

          {tab === "Job cards" && (
            <div className="space-y-3">
              {snapshot.jobCards.map((job) => (
                <div key={job.id} className="card space-y-4">
                  <div><p className="font-semibold">Job #{job.number} · {job.vehicle}</p><p className="text-xs text-muted-foreground">{job.customer} · {job.status} · {job.description}</p></div>
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
                          <form className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]" onSubmit={(event) => void queue(event, { type: "jobcard.inspection", recordId: item.id, parentId: job.id, baseVersion: job.updatedAt })}>
                            <select name="status" className="input" defaultValue={item.status}>{INSPECTION_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select>
                            <input name="notes" className="input" defaultValue={item.notes ?? ""} placeholder="Inspection note" />
                            <button className="btn-secondary btn-sm">Queue update</button>
                          </form>
                          <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => void queue(event, { type: "inspection.photo", recordId: item.id, parentId: job.id })}>
                            <PhotoUploadField required name="file" maxPhotos={1} className="min-w-0 flex-1 text-xs text-muted-foreground" />
                            <button className="btn-secondary btn-sm">{item.hasPhoto ? "Replace photo" : "Queue photo"}</button>
                          </form>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === "Deliveries" && (
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.deliveries.map((delivery) => (
                <div key={delivery.id} className="card">
                  <p className="font-semibold">Quote Q-{delivery.number}</p>
                  <p className="text-xs text-muted-foreground">{delivery.customer}{delivery.scheduledFor ? ` · ${new Date(delivery.scheduledFor).toLocaleString("en-ZA")}` : ""}</p>
                  <ProofOfDelivery quoteId={delivery.id} baseVersion={delivery.updatedAt} />
                  <form className="mt-3 border-t border-border pt-3" onSubmit={(event) => void queue(event, { type: "delivery.photo", recordId: delivery.id })}>
                    <label className="mb-2 block text-xs font-semibold">Delivery photos</label>
                    <PhotoUploadField required className="block w-full text-xs text-muted-foreground" />
                    <button className="btn-secondary btn-sm mt-2 w-full">Queue delivery photos</button>
                  </form>
                </div>
              ))}
            </div>
          )}

          {tab === "Pending" && (
            <div className="space-y-3">
              {entries.length === 0 ? <div className="card text-sm text-muted-foreground">Nothing is waiting to synchronise.</div> : entries.map((entry) => (
                <div key={entry.id} className="card flex items-start justify-between gap-3">
                  <div><p className="font-semibold">{entry.operation.type}</p><p className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString("en-ZA")} · {entry.status}</p>{entry.error && <p className="mt-1 text-xs text-red-300">{entry.error}</p>}</div>
                  <button type="button" className="btn-secondary btn-sm" onClick={async () => { await removeOfflineMutation(entry.id); await reloadEntries(); }}>Discard</button>
                </div>
              ))}
              {offline.online && entries.length > 0 && <button type="button" className="btn-primary w-full" onClick={() => void offline.syncNow()}>Synchronise now</button>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
