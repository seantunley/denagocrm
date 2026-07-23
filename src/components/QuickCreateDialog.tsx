"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { QuoteEditorDialog } from "@/components/quotes/QuoteEditorDialog";
import { createLead } from "@/app/actions/leads";
import { createContact } from "@/app/actions/contacts";
import { createVehicle } from "@/app/actions/vehicles";
import { scheduleActivity } from "@/app/actions/activities";
import LocationAutocomplete from "@/components/LocationAutocomplete";

export type QuickCreateKind = "lead" | "contact" | "calendar" | "quote" | "jobcard" | "vehicle";

export type QuickCreateDefaults = {
  dueDate?: string;
  workshop?: boolean;
  revalidate?: string;
  contactId?: string;
  contactLabel?: string;
};

const TITLES: Record<QuickCreateKind, string> = {
  lead: "New lead",
  contact: "New contact",
  calendar: "New calendar item",
  quote: "New quote",
  jobcard: "New job card",
  vehicle: "Register vehicle",
};

export function openQuickCreate(kind: QuickCreateKind, defaults?: QuickCreateDefaults) {
  window.dispatchEvent(new CustomEvent("denago:quick-create", { detail: { kind, defaults } }));
}

type Options = {
  products: { id: string; name: string; basePriceCents: number; colors: string[] }[];
  stages: { id: string; name: string }[];
  contacts: { id: string; label: string }[];
  users: { id: string; name: string }[];
  vehicles: { id: string; label: string }[];
  quoteDefaults: { validUntil: string; terms: string };
};

/**
 * Global create-anything dialog. Reuses the existing form components + server
 * actions; option lists are fetched once per session on first open.
 */
export default function QuickCreateDialog() {
  const [kind, setKind] = useState<QuickCreateKind | null>(null);
  const [createDefaults, setCreateDefaults] = useState<QuickCreateDefaults>({});
  const [options, setOptions] = useState<Options | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calendarType, setCalendarType] = useState<string>("call");

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<QuickCreateKind | { kind: QuickCreateKind; defaults?: QuickCreateDefaults }>).detail;
      // Keep accepting the original string event shape for older callers.
      if (typeof detail === "string") {
        setKind(detail);
        setCreateDefaults({});
        return;
      }
      setKind(detail.kind);
      setCreateDefaults(detail.defaults ?? {});
    };
    window.addEventListener("denago:quick-create", onOpen);
    return () => window.removeEventListener("denago:quick-create", onOpen);
  }, []);

  useEffect(() => {
    if (!kind || options) return;
    let cancelled = false;
    fetch("/api/quick-create")
      .then(async (response) => {
        // A 403 (no create permission) returns { error } JSON — never treat that
        // as an options payload, or the forms crash mapping undefined lists.
        if (!response.ok) {
          throw new Error(
            response.status === 403
              ? "You don't have permission to create items here."
              : "Could not load the create options."
          );
        }
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setOptions(data as Options);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Could not load the create options.";
        setLoadError(message);
        toast.error(message);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, options]);

  // Reset the calendar type to a sensible default whenever the dialog re-opens.
  useEffect(() => {
    setCalendarType(createDefaults.workshop ? "meeting" : "call");
  }, [createDefaults]);

  const input =
    "w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";

  function close() {
    setKind(null);
    setCreateDefaults({});
    setLoadError(null);
  }

  async function scheduleCalendar(formData: FormData) {
    try {
      await scheduleActivity(formData);
      close();
      toast.success("Activity scheduled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not schedule activity");
    }
  }

  if (kind === "quote" && options) {
    return (
      <QuoteEditorDialog
        open
        onOpenChange={(next) => !next && close()}
        contacts={options.contacts}
        products={options.products}
        defaults={options.quoteDefaults}
      />
    );
  }

  return (
    <Dialog open={Boolean(kind)} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader className="text-left">
          <DialogTitle>{kind ? TITLES[kind] : ""}</DialogTitle>
        </DialogHeader>

        {loadError ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{loadError}</div>
        ) : !options ? (
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
                defaults={{
                  contactId: createDefaults.contactId,
                  name: createDefaults.contactLabel,
                }}
                submitLabel="Create lead"
                variant="dialog"
              />
            )}

            {kind === "contact" && (
              <ContactForm action={createContact} users={options.users} submitLabel="Create contact" variant="dialog" />
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

            {kind === "calendar" && (
              <form action={scheduleCalendar} className="space-y-4">
                <input type="hidden" name="revalidate" value={createDefaults.revalidate ?? "/"} />
                <div className="rounded-xl border border-border bg-card/45 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Schedule the next step</p>
                  <p className="mt-1 text-sm text-muted-foreground">Add the owner, customer context and location so the diary is useful to the whole team.</p>
                </div>
                <div>
                  <label className="label">What needs to happen? *</label>
                  <input name="summary" className={input} required placeholder="e.g. Product demo for the estate manager" autoFocus />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Type</label>
                    <select name="type" className={input} value={calendarType} onChange={(e) => setCalendarType(e.target.value)}>
                      <option value="call">Call</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="email">Email</option>
                      <option value="meeting">Meeting</option>
                      <option value="test_drive">Test drive</option>
                      <option value="follow_up">Follow-up</option>
                      <option value="todo">To-do</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">When *</label>
                    <input type="datetime-local" name="dueDate" className={input} defaultValue={createDefaults.dueDate} required />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Customer or contact</label>
                    <select name="contactId" className={input} defaultValue={createDefaults.contactId ?? ""}>
                      <option value="">—</option>
                      {options.contacts.map((contact) => (
                        <option key={contact.id} value={contact.id}>{contact.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Assign to</label>
                    <select name="assignedToId" className={input} defaultValue="">
                      <option value="">Me</option>
                      {options.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Location</label>
                  <LocationAutocomplete className={input} placeholder="Showroom, workshop or customer address" />
                </div>
                <div>
                  <label className="label">
                    {calendarType === "follow_up" ? "Follow-up note *" : "Internal note"}
                  </label>
                  <textarea
                    name="note"
                    className={`${input} min-h-20 resize-y`}
                    required={calendarType === "follow_up"}
                    placeholder={
                      calendarType === "follow_up"
                        ? "e.g. Customer will get back to us in 2 weeks after speaking to their partner"
                        : "Preparation, customer request or handover detail…"
                    }
                  />
                </div>
                <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input type="checkbox" name="workshop" className="h-4 w-4 accent-orange-600" defaultChecked={createDefaults.workshop} />
                    Workshop booking
                  </label>
                  <button className="btn-primary">Schedule activity</button>
                </div>
              </form>
            )}
          </>
        )}
      </ResponsiveDialogContent>
    </Dialog>
  );
}
