"use client";

import { useActionState } from "react";
import { requestService } from "@/app/actions/portal";

export default function ServiceRequestForm({
  vehicles,
}: {
  vehicles: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(requestService, undefined);

  if (state?.ok) {
    return <p className="text-sm text-emerald-400">{state.ok}</p>;
  }

  return (
    <form action={action} className="space-y-3">
      {vehicles.length > 0 && (
        <div>
          <label className="label">Which cart?</label>
          <select name="vehicleId" className="input" defaultValue="">
            <option value="">— select —</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="label">Preferred date</label>
        <input name="preferred" type="date" className="input" />
      </div>
      <div>
        <label className="label">What do you need?</label>
        <textarea name="notes" className="input" rows={3} placeholder="Describe the problem or service…" />
      </div>
      {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button className="btn-primary" disabled={pending}>
        {pending ? "Sending…" : "Request a service"}
      </button>
    </form>
  );
}
