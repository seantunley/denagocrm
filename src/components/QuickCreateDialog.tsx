"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import LeadForm from "@/components/LeadForm";
import ContactForm from "@/components/ContactForm";
import JobCardForm from "@/components/JobCardForm";
import VehicleForm from "@/components/VehicleForm";
import { createLead } from "@/app/actions/leads";
import { createContact } from "@/app/actions/contacts";
import { createVehicle } from "@/app/actions/vehicles";
import { createQuoteForContact } from "@/app/actions/quotes";
import { scheduleActivity } from "@/app/actions/activities";

export type QuickCreateKind = "lead" | "contact" | "calendar" | "quote" | "jobcard" | "vehicle";

const TITLES: Record<QuickCreateKind, string> = {
  lead: "New lead",
  contact: "New contact",
  calendar: "New calendar item",
  quote: "New quote",
  jobcard: "New job card",
  vehicle: "Register vehicle",
};

export function openQuickCreate(kind: QuickCreateKind) {
  window.dispatchEvent(new CustomEvent("denago:quick-create", { detail: kind }));
}

type Options = {
  products: { id: string; name: string; basePriceCents: number; colors: string[] }[];
  stages: { id: string; name: string }[];
  contacts: { id: string; label: string }[];
  users: { id: string; name: string }[];
  vehicles: { id: string; label: string }[];
};

/**
 * Global create-anything dialog. Reuses the existing form components + server
 * actions; option lists are fetched once per session on first open.
 */
export default function QuickCreateDialog() {
  const [kind, setKind] = useState<QuickCreateKind | null>(null);
  const [options, setOptions] = useState<Options | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setKind((e as CustomEvent).detail as QuickCreateKind);
    window.addEventListener("denago:quick-create", onOpen);
    return () => window.removeEventListener("denago:quick-create", onOpen);
  }, []);

  useEffect(() => {
    if (!kind || options) return;
    fetch("/api/quick-create")
      .then((r) => r.json())
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [kind, options]);

  const input =
    "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && setKind(null)}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader className="text-left">
          <DialogTitle>{kind ? TITLES[kind] : ""}</DialogTitle>
        </DialogHeader>

        {!options ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            {kind === "lead" && (
              <LeadForm
                action={createLead}
                products={options.products}
                stages={options.stages}
                contacts={options.contacts}
                users={options.users}
                submitLabel="Create lead"
              />
            )}

            {kind === "contact" && (
              <ContactForm action={createContact} users={options.users} submitLabel="Create contact" />
            )}

            {kind === "jobcard" && <JobCardForm vehicles={options.vehicles} />}

            {kind === "vehicle" && (
              <VehicleForm
                action={createVehicle}
                contacts={options.contacts}
                products={options.products}
                submitLabel="Register vehicle"
                showInitialKm
                variant="dialog"
              />
            )}

            {kind === "quote" && (
              <form action={createQuoteForContact} className="space-y-4">
                <div>
                  <label className="label">Customer *</label>
                  <select name="contactId" className={input} required defaultValue="">
                    <option value="" disabled>
                      Select customer…
                    </option>
                    {options.contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Product (optional — pre-fills the first line)</label>
                  <select name="productId" className={input} defaultValue="">
                    <option value="">— start empty —</option>
                    {options.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn-primary">Create quote</button>
              </form>
            )}

            {kind === "calendar" && (
              <form action={scheduleActivity} className="space-y-4">
                <input type="hidden" name="revalidate" value="/" />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Type</label>
                    <select name="type" className={input} defaultValue="call">
                      <option value="call">Call</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="email">Email</option>
                      <option value="meeting">Meeting</option>
                      <option value="test_drive">Test drive</option>
                      <option value="todo">To-do</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">When *</label>
                    <input type="datetime-local" name="dueDate" className={input} required />
                  </div>
                </div>
                <div>
                  <label className="label">What *</label>
                  <input name="summary" className={input} required placeholder="e.g. Demo for the estate manager" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Contact (optional)</label>
                    <select name="contactId" className={input} defaultValue="">
                      <option value="">—</option>
                      {options.contacts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Location (optional)</label>
                    <input name="location" className={input} placeholder="Showroom, address…" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" name="workshop" className="h-4 w-4 accent-orange-600" />
                  Workshop calendar (service job)
                </label>
                <button className="btn-primary">Schedule</button>
              </form>
            )}
          </>
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}
