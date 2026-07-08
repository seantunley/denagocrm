"use client";

import { useActionState } from "react";
import { remindService, type RemindResult } from "@/app/actions/vehicles";

export default function ServiceReminderButton({ vehicleId }: { vehicleId: string }) {
  const [state, action, pending] = useActionState<RemindResult, FormData>(remindService, null);

  if (state?.ok) {
    return (
      <span className="text-xs text-emerald-400">
        Reminded via {state.channel === "sms" ? "SMS" : "email"} ✓
      </span>
    );
  }

  return (
    <form action={action} className="inline">
      <input type="hidden" name="vehicleId" value={vehicleId} />
      <button className="btn-secondary btn-sm" disabled={pending}>
        {pending ? "Sending…" : "Remind"}
      </button>
      {state?.error && <span className="text-xs text-red-400 ml-2">{state.error}</span>}
    </form>
  );
}
