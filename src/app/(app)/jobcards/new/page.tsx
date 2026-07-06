import { prisma } from "@/lib/db";
import { createJobCard } from "@/app/actions/jobcards";
import { contactName } from "@/lib/format";

export default async function NewJobCardPage({
  searchParams,
}: {
  searchParams: Promise<{ vehicleId?: string }>;
}) {
  const { vehicleId } = await searchParams;
  const vehicles = await prisma.vehicle.findMany({
    include: { contact: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">New job card</h1>
      <form action={createJobCard} className="card space-y-4 max-w-xl">
        <div>
          <label className="label">Vehicle *</label>
          <select name="vehicleId" className="input" required defaultValue={vehicleId ?? ""}>
            <option value="">Select vehicle…</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.model}
                {v.vin ? ` (${v.vin})` : ""} — {contactName(v.contact)}
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
            placeholder="e.g. 1,000 km service — brakes, gears, battery check"
          />
        </div>
        <div>
          <label className="label">Mileage at check-in (km)</label>
          <input type="number" name="kmIn" className="input" />
        </div>
        <button className="btn-primary">Open job card</button>
      </form>
    </div>
  );
}
