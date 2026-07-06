import { createJobCard } from "@/app/actions/jobcards";

export default function JobCardForm({
  vehicles,
  defaultVehicleId,
}: {
  vehicles: { id: string; label: string }[];
  defaultVehicleId?: string;
}) {
  return (
    <form action={createJobCard} className="card space-y-4">
      <div>
        <label className="label">Vehicle *</label>
        <select name="vehicleId" className="input" required defaultValue={defaultVehicleId ?? ""}>
          <option value="">Select vehicle…</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Work requested / description *</label>
        <textarea
          name="description"
          className="input"
          rows={3}
          required
          placeholder="e.g. 1,000 km service — brakes, battery check"
        />
      </div>
      <div>
        <label className="label">Mileage at check-in (km)</label>
        <input type="number" name="kmIn" className="input" />
      </div>
      <button className="btn-primary">Open job card</button>
    </form>
  );
}
