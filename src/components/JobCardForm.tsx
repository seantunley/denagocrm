import { ArrowRight, CarFront, ClipboardList, Gauge, ShieldCheck } from "lucide-react";
import { createJobCard } from "@/app/actions/jobcards";
import { StickyActionArea } from "@/components/responsive-patterns";

export default function JobCardForm({
  vehicles,
  defaultVehicleId,
}: {
  vehicles: { id: string; label: string }[];
  defaultVehicleId?: string;
}) {
  return (
    <form action={createJobCard} className="space-y-6">
      <div className="rounded-2xl border border-primary/20 bg-primary/[0.055] p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <ClipboardList className="size-[18px]" />
          </span>
          <div>
            <p className="font-semibold tracking-tight">Vehicle intake</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Capture the customer request and arrival mileage. The job number and technician assignment are created automatically.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div>
          <label className="label" htmlFor="job-card-vehicle"><CarFront className="mr-1 inline size-3.5" />Vehicle</label>
          <select id="job-card-vehicle" name="vehicleId" className="input" required defaultValue={defaultVehicleId ?? ""}>
            <option value="">Select a vehicle…</option>
            {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}</option>)}
          </select>
          <p className="mt-1.5 text-[11px] text-muted-foreground">The vehicle determines the customer and future service history.</p>
        </div>
        <div>
          <label className="label" htmlFor="job-card-mileage"><Gauge className="mr-1 inline size-3.5" />Arrival mileage</label>
          <div className="relative">
            <input id="job-card-mileage" type="number" min="0" name="kmIn" className="input pr-10" inputMode="numeric" placeholder="0" />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">km</span>
          </div>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="job-card-description">Work requested</label>
        <textarea
          id="job-card-description"
          name="description"
          className="input min-h-32 resize-y"
          required
          placeholder="Describe the customer concern, requested service, warning lights, noises or inspection scope…"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground">Write this so both the technician and customer can understand the agreed scope.</p>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/25 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
        The job card opens in Waiting status and is assigned to you. Check-in photos, parts, labour and customer signature are added in the workspace.
      </div>

      <StickyActionArea className="justify-end">
        <button className="btn-primary w-full sm:w-auto">Open job card <ArrowRight className="size-4" /></button>
      </StickyActionArea>
    </form>
  );
}
