"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
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
import type { FleetPicker } from "@/lib/fleetTypes";
import { QuoteEditorDialog, type QuoteEditorDefaults } from "@/components/quotes/QuoteEditorDialog";
import {
  createQuickContact,
  createQuickLead,
  createQuickVehicle,
  scheduleQuickActivity,
} from "@/app/actions/quickCreate";
import { createStaffAvailability } from "@/app/actions/staffAvailability";
import { AvailabilityConflictDialog } from "@/components/AvailabilityConflictDialog";
import LocationAutocomplete from "@/components/LocationAutocomplete";
import { readPwaActivityShortcut } from "@/lib/pwaShortcuts";
import { useActivityTypes } from "@/components/ActivityTypesProvider";
import { pickableActivityTypes } from "@/lib/activityTypes";

export type QuickCreateKind = "lead" | "contact" | "calendar" | "availability" | "quote" | "jobcard" | "vehicle";

export type QuickCreateDefaults = {
  dueDate?: string;
  endDate?: string;
  workshop?: boolean;
  revalidate?: string;
  contactId?: string;
  contactLabel?: string;
};

const TITLES: Record<QuickCreateKind, string> = {
  lead: "New Lead",
  contact: "New Contact",
  calendar: "New Activity",
  availability: "Block availability",
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
  fleetPicker: FleetPicker;
  /** Sent only when the quote dialog is asked for (or the legacy full payload). */
  quoteDefaults: QuoteEditorDefaults | null;
};

/** Global create dialog with contextual defaults and tenant-validated writes. */
export default function QuickCreateDialog() {
  const [kind, setKind] = useState<QuickCreateKind | null>(null);
  const [createDefaults, setCreateDefaults] = useState<QuickCreateDefaults>({});
  const [options, setOptions] = useState<Options | null>(null);
  const [optionsKind, setOptionsKind] = useState<QuickCreateKind | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calendarType, setCalendarType] = useState<string>("call");
  const [availabilityAllDay, setAvailabilityAllDay] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const activityTypes = useActivityTypes();

  // Close FOR REAL when the route changes. The Dialog wrapper only hides a
  // dialog on navigation (ui/dialog.tsx), and this one lives in the shell across
  // routes: `kind` stayed set, so a quote editor holding a saved quote sat
  // mounted and invisible, and asking for Quick create again (same `kind`)
  // could never bring it back. Nothing survives here that the hide didn't
  // already put out of reach.
  const pathname = usePathname();
  const [openedPathname, setOpenedPathname] = useState(pathname);
  if (pathname !== openedPathname) {
    setOpenedPathname(pathname);
    if (kind) {
      setKind(null);
      setCreateDefaults({});
      setLoadError(null);
    }
  }

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<QuickCreateKind | { kind: QuickCreateKind; defaults?: QuickCreateDefaults }>).detail;
      if (typeof detail === "string") {
        setKind(detail);
        setCreateDefaults({});
        return;
      }
      setKind(detail.kind);
      setCreateDefaults(detail.defaults ?? {});
    };
    window.addEventListener("denago:quick-create", onOpen);

    const launcherShortcut = readPwaActivityShortcut(window.location.href);
    if (launcherShortcut) {
      openQuickCreate("calendar", { revalidate: "/calendar" });
      window.history.replaceState(
        window.history.state,
        "",
        launcherShortcut.cleanUrl,
      );
    }

    return () => window.removeEventListener("denago:quick-create", onOpen);
  }, []);

  useEffect(() => {
    if (!kind || optionsKind === kind) return;
    let cancelled = false;
    fetch(`/api/quick-create?kind=${encodeURIComponent(kind)}`)
      .then(async (response) => {
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
        setOptionsKind(kind);
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
  }, [kind, optionsKind]);

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
      const result = await scheduleQuickActivity(formData);
      if (result?.error) {
        setConflictMessage(result.error);
        return;
      }
      close();
      toast.success(result?.success ?? "Activity scheduled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not schedule activity");
    }
  }

  async function scheduleAvailability(formData: FormData) {
    try {
      const result = await createStaffAvailability(formData);
      if (result.error) {
        setConflictMessage(result.error);
        return;
      }
      close();
      toast.success(result.success ?? "Availability blocked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not block availability");
    }
  }

  const currentOptions = optionsKind === kind ? options : null;

  if (kind === "quote" && currentOptions?.quoteDefaults) {
    return (
      <QuoteEditorDialog
        open
        onOpenChange={(next) => !next && close()}
        contacts={currentOptions.contacts}
        products={currentOptions.products}
        defaults={currentOptions.quoteDefaults}
      />
    );
  }

  return (
    <>
    <Dialog open={Boolean(kind)} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader className="text-left">
          <DialogTitle>{kind ? TITLES[kind] : ""}</DialogTitle>
        </DialogHeader>

        {loadError ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{loadError}</div>
        ) : !currentOptions ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <>
            {kind === "lead" && (
              <LeadForm
                action={createQuickLead}
                products={currentOptions.products}
                stages={currentOptions.stages}
                contacts={currentOptions.contacts}
                users={currentOptions.users}
                defaults={{
                  contactId: createDefaults.contactId,
                  name: createDefaults.contactLabel,
                }}
                submitLabel="Create lead"
                variant="dialog"
              />
            )}

            {kind === "contact" && (
              <ContactForm action={createQuickContact} users={currentOptions.users} fleetPicker={currentOptions.fleetPicker} submitLabel="Create contact" variant="dialog" />
            )}

            {kind === "jobcard" && <JobCardForm vehicles={currentOptions.vehicles} />}

            {kind === "vehicle" && (
              <VehicleForm
                action={createQuickVehicle}
                contacts={currentOptions.contacts}
                products={currentOptions.products}
                submitLabel="Register vehicle"
                showInitialKm
                variant="dialog"
              />
            )}

            {kind === "availability" && (
              <form action={scheduleAvailability} className="space-y-4">
                <input type="hidden" name="revalidate" value={createDefaults.revalidate ?? "/calendar"} />
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">Staff availability</p>
                  <p className="mt-1 text-sm text-muted-foreground">This blocks customer meetings, test drives and other scheduled work for the selected team member.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Reason *</label>
                    <select name="summary" className={input} defaultValue="Leave" required>
                      <option>Leave</option>
                      <option>Personal appointment</option>
                      <option>Training</option>
                      <option>Off-site</option>
                      <option>Internal meeting</option>
                      <option>Unavailable</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Team member *</label>
                    <select name="assignedToId" className={input} defaultValue="">
                      <option value="">Me</option>
                      {currentOptions.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    name="allDay"
                    className="h-4 w-4 accent-orange-600"
                    checked={availabilityAllDay}
                    onChange={(event) => setAvailabilityAllDay(event.target.checked)}
                  />
                  All day / multiple full days
                </label>
                {availabilityAllDay ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label">First day *</label>
                      <input type="date" name="startDate" className={input} required defaultValue={createDefaults.dueDate?.slice(0, 10)} />
                    </div>
                    <div>
                      <label className="label">Last day *</label>
                      <input type="date" name="endDate" className={input} required defaultValue={(createDefaults.endDate ?? createDefaults.dueDate)?.slice(0, 10)} />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="label">From *</label>
                      <input type="datetime-local" name="startAt" className={input} required defaultValue={createDefaults.dueDate} />
                    </div>
                    <div>
                      <label className="label">Until *</label>
                      <input type="datetime-local" name="endAt" className={input} required defaultValue={createDefaults.endDate} />
                    </div>
                  </div>
                )}
                <div>
                  <label className="label">Note *</label>
                  <textarea
                    name="note"
                    className={`${input} min-h-24 resize-y`}
                    required
                    placeholder="e.g. Annual leave — out of office and not available for appointments"
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">The calendar shows this note with the staff member&apos;s name.</p>
                </div>
                <div className="flex justify-end border-t border-border pt-4">
                  <button className="btn-primary">Block this time</button>
                </div>
              </form>
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
                      {pickableActivityTypes(activityTypes).map((type) => (
                        <option key={type.key} value={type.key}>
                          {type.emoji} {type.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Starts *</label>
                    <input type="datetime-local" name="dueDate" className={input} defaultValue={createDefaults.dueDate} required />
                  </div>
                  <div>
                    <label className="label">Ends *</label>
                    <input type="datetime-local" name="endDate" className={input} defaultValue={createDefaults.endDate} required />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">Customer or contact</label>
                    <select name="contactId" className={input} defaultValue={createDefaults.contactId ?? ""}>
                      <option value="">—</option>
                      {currentOptions.contacts.map((contact) => (
                        <option key={contact.id} value={contact.id}>{contact.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Assign to</label>
                    <select name="assignedToId" className={input} defaultValue="">
                      <option value="">Me</option>
                      {currentOptions.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
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
    <AvailabilityConflictDialog
      message={conflictMessage}
      onClose={() => setConflictMessage(null)}
      title={kind === "availability" ? "Cannot block this time" : "Staff member unavailable"}
    />
    </>
  );
}
