"use client";

import { useState } from "react";
import { ArrowRight, CarFront, ClipboardList, Gauge, ShieldCheck, UserRound } from "lucide-react";
import { createJobCard } from "@/app/actions/jobcards";
import { StickyActionArea } from "@/components/responsive-patterns";
import ContactPicker from "@/components/ContactPicker";
import { FormDetailDisclosure } from "@/components/FormDetailDisclosure";
import { useFormDetailMode } from "@/hooks/useFormDetailMode";
import { PRIORITIES } from "@/lib/workshop-constants";
import { cn } from "@/lib/utils";

/**
 * Open a job card: on a vehicle (its owner is the customer, and the job joins the vehicle's service history), or —
 * for work that isn't on a vehicle — for a customer alone, with no mileage and no service history.
 */
export default function JobCardForm({
  vehicles,
  defaultVehicleId,
  contacts = [],
  detail = "full",
}: {
  vehicles: { id: string; label: string }[];
  defaultVehicleId?: string;
  /** Customers for a job with no vehicle. Empty: only the vehicle choice is offered. */
  contacts?: { id: string; label: string }[];
  /** "collapsible": the create page — what the job is for, the work and its priority; mileage behind "Add more detail". */
  detail?: "full" | "collapsible";
}) {
  const [onVehicle, setOnVehicle] = useState(true);
  const collapsible = detail === "collapsible";
  const [expanded, setExpanded] = useFormDetailMode("jobcard");
  const showDetail = !collapsible || expanded;
  const choice = (active: boolean) =>
    cn("rounded-lg border px-3 py-1.5 text-xs font-medium", active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground");

  const mileageField = (
    <div>
      <label className="label" htmlFor="job-card-mileage"><Gauge className="mr-1 inline size-3.5" />Arrival mileage</label>
      <div className="relative">
        <input id="job-card-mileage" type="number" min="0" name="kmIn" className="input pr-10" inputMode="numeric" placeholder="0" />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">km</span>
      </div>
    </div>
  );

  const openingNote = (
    <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/25 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
      The job card opens in Waiting status and is assigned to you. Check-in photos, parts, labour and customer signature are added in the workspace.
    </div>
  );

  return (
    <form action={createJobCard} className={cn("space-y-6", collapsible && "space-y-4")}>
      {showDetail && (
        <div className="rounded-2xl border border-primary/20 bg-primary/[0.055] p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
              <ClipboardList className="size-[18px]" />
            </span>
            <div>
              <p className="font-semibold tracking-tight">{onVehicle ? "Vehicle intake" : "New job"}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {onVehicle ? "Capture the customer request and arrival mileage." : "Capture what the customer asked for."} The job number and technician
                assignment are created automatically.
              </p>
            </div>
          </div>
        </div>
      )}

      {contacts.length > 0 && (
        <div className="flex gap-2" role="group" aria-label="What the job is for">
          <button type="button" className={choice(onVehicle)} aria-pressed={onVehicle} onClick={() => setOnVehicle(true)}>
            <CarFront className="mr-1 inline size-3.5" />On a vehicle
          </button>
          <button type="button" className={choice(!onVehicle)} aria-pressed={!onVehicle} onClick={() => setOnVehicle(false)}>
            <UserRound className="mr-1 inline size-3.5" />Customer only
          </button>
        </div>
      )}

      {onVehicle ? (
        <div className={cn("grid gap-4", !collapsible && "sm:grid-cols-[minmax(0,1fr)_12rem]")}>
          <div>
            <label className="label" htmlFor="job-card-vehicle"><CarFront className="mr-1 inline size-3.5" />Vehicle</label>
            <select id="job-card-vehicle" name="vehicleId" className="input" required defaultValue={defaultVehicleId ?? ""}>
              <option value="">Select a vehicle…</option>
              {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}</option>)}
            </select>
            <p className="mt-1.5 text-[11px] text-muted-foreground">The vehicle determines the customer and future service history.</p>
          </div>
          {!collapsible && mileageField}
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="job-card-contact"><UserRound className="mr-1 inline size-3.5" />Customer</label>
          <ContactPicker id="job-card-contact" name="contactId" options={contacts} required />
          <p className="mt-1.5 text-[11px] text-muted-foreground">For work that isn&apos;t on a vehicle: no mileage and no service history.</p>
        </div>
      )}

      <div>
        <label className="label" htmlFor="job-card-description">Work requested</label>
        <textarea
          id="job-card-description"
          name="description"
          className={cn("input resize-y", collapsible ? "min-h-24" : "min-h-32")}
          required
          placeholder={onVehicle ? "Describe the customer concern, requested service, warning lights, noises or inspection scope…" : "Describe what the customer asked for…"}
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">Write this so both the technician and customer can understand the agreed scope.</p>
      </div>

      <div className="sm:max-w-xs">
        <label className="label" htmlFor="job-card-priority">Priority</label>
        <select id="job-card-priority" name="priority" className="input" defaultValue="normal">
          {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      {collapsible ? (
        <FormDetailDisclosure
          expanded={expanded}
          onToggle={setExpanded}
          hint={onVehicle ? "Arrival mileage." : "Nothing more is needed for a job without a vehicle."}
        >
          {/* Mileage is a vehicle's; the action ignores it for a job without one. */}
          {onVehicle && <div className="sm:max-w-xs">{mileageField}</div>}
          {openingNote}
        </FormDetailDisclosure>
      ) : (
        openingNote
      )}

      <StickyActionArea className="justify-end">
        <button className="btn-primary w-full sm:w-auto">Open job card <ArrowRight className="size-4" /></button>
      </StickyActionArea>
    </form>
  );
}
