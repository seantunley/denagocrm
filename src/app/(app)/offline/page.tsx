"use client";

import { useEffect, useState, type FormEvent } from "react";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { useOffline } from "@/components/OfflineProvider";
import { listOfflineMutations, removeOfflineMutation } from "@/lib/offlineClient";
import type { OfflineDescriptor, OfflineMutation } from "@/lib/offlineTypes";

const tabs = ["Leads", "Contacts", "Job cards", "Deliveries", "Pending"] as const;
type Tab = (typeof tabs)[number];

export default function OfflineWorkspacePage() {
  const offline = useOffline();
  const [tab, setTab] = useState<Tab>("Job cards");
  const [entries, setEntries] = useState<OfflineMutation[]>([]);

  async function reloadEntries() {
    if (!offline.snapshot) return;
    setEntries(await listOfflineMutations(offline.snapshot.tenantId, offline.snapshot.userId));
  }

  useEffect(() => { void reloadEntries(); }, [offline.pending, offline.snapshot]);

  async function queue(event: FormEvent<HTMLFormElement>, operation: OfflineDescriptor) {
    event.preventDefault();
    const form = event.currentTarget;
    await offline.queue(operation, new FormData(form));
    form.reset();
    if (offline.online) await offline.syncNow();
  }

  const snapshot = offline.snapshot;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Offline field workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {offline.online ? "Connected. Cached field records and queued work are up to date." : "No connection. Work is stored on this device until synchronisation."}
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm" disabled={!offline.online} onClick={() => void offline.refreshSnapshot()}>
          Refresh offline data
        </button>
      </div>

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
                {snapshot.leads.map((lead) => <div key={lead.id} className="card"><p className="font-semibold">{lead.title}</p><p className="text-sm text-muted-foreground">{lead.name} · {lead.stage}</p><p className="mt-2 text-xs text-muted-foreground">{lead.phone ?? lead.email ?? "No contact channel"}</p></div>)}
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
                {snapshot.contacts.map((contact) => <div key={contact.id} className="card"><p className="font-semibold">{contact.name}</p><p className="text-xs text-muted-foreground">{contact.phone ?? contact.whatsapp ?? contact.email ?? "No contact channel"}</p></div>)}
              </div>
            </div>
          )}

          {tab === "Job cards" && (
            <div className="space-y-3">
              {snapshot.jobCards.map((job) => (
                <form key={job.id} className="card space-y-3" onSubmit={(event) => void queue(event, { type: "jobcard.notes", recordId: job.id, baseVersion: job.updatedAt })}>
                  <div><p className="font-semibold">Job #{job.number} · {job.vehicle}</p><p className="text-xs text-muted-foreground">{job.customer} · {job.status} · {job.description}</p></div>
                  <textarea name="checkinNotes" className="input" defaultValue={job.checkinNotes ?? ""} placeholder="Check-in condition notes" />
                  <textarea name="checkoutNotes" className="input" defaultValue={job.checkoutNotes ?? ""} placeholder="Check-out condition notes" />
                  <button className="btn-secondary btn-sm">Save notes on this device</button>
                </form>
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
