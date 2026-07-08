"use client";

import { useActionState } from "react";
import { sendToAudience, type SendResult } from "@/app/actions/surveys";

const SEGMENTS = [
  { id: "test", label: "Send a test to myself" },
  { id: "customers", label: "All customers (reachable, not opted out)" },
  { id: "vehicle_owners", label: "Cart owners (have a vehicle on file)" },
  { id: "won_leads", label: "Customers who bought (won deals)" },
];

export default function SurveySendPanel({
  surveyId,
  autoNote,
}: {
  surveyId: string;
  autoNote?: string;
}) {
  const [state, action, pending] = useActionState<SendResult, FormData>(sendToAudience, null);

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Send this survey</h2>
      {autoNote && <p className="text-xs text-slate-400">{autoNote}</p>}
      <form action={action} className="flex flex-col sm:flex-row gap-2">
        <input type="hidden" name="surveyId" value={surveyId} />
        <select name="segment" className="input sm:flex-1" defaultValue="test">
          {SEGMENTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn-primary" disabled={pending}>
          {pending ? "Sending…" : "Send now"}
        </button>
      </form>
      {state && (
        <p className="text-sm">
          {state.test ? (
            state.sent ? (
              <span className="text-emerald-400">Test sent — check your inbox.</span>
            ) : (
              <span className="text-red-400">
                Couldn&apos;t send — is your email set and SMTP configured?
              </span>
            )
          ) : (
            <span className="text-emerald-400">
              Sent to {state.sent} recipient{state.sent === 1 ? "" : "s"}.
              {state.skipped > 0 && (
                <span className="text-slate-500">
                  {" "}
                  {state.skipped} skipped (recently surveyed, opted out, or no contact detail).
                </span>
              )}
            </span>
          )}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Recipients only get one survey of each type every 30 days, so it&apos;s safe to resend.
      </p>
    </div>
  );
}
