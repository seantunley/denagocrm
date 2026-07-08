"use client";

import { useActionState } from "react";
import { notifyRecall, type NotifyResult } from "@/app/actions/warranty";

export default function RecallNotifyButton({
  recallId,
  affected,
}: {
  recallId: string;
  affected: number;
}) {
  const [state, action, pending] = useActionState<NotifyResult, FormData>(notifyRecall, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="recallId" value={recallId} />
      <button className="btn-secondary btn-sm" disabled={pending || affected === 0}>
        {pending ? "Sending…" : `Notify ${affected} owner${affected === 1 ? "" : "s"}`}
      </button>
      {state && <span className="text-xs text-emerald-400">Sent {state.sent}, skipped {state.skipped}</span>}
    </form>
  );
}
