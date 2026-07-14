"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { decideApproval } from "@/app/actions/signhub";

export function ApprovalActions({ stepId }: { stepId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function act(decision: "approve" | "reject") {
    if (decision === "reject" && !rejecting) { setRejecting(true); return; }
    setBusy(decision); setErr(null);
    const res = await decideApproval(stepId, decision, reason.trim());
    setBusy(null);
    if (!res.ok) { setErr(res.error ?? "Failed"); return; }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {rejecting && (
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejection"
          className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground" />
      )}
      <div className="flex items-center gap-2">
        <button disabled={busy !== null} onClick={() => act("approve")}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60">
          {busy === "approve" ? "Approving…" : "✓ Approve"}
        </button>
        <button disabled={busy !== null} onClick={() => act("reject")}
          className={`rounded-md px-3 py-1.5 text-sm font-semibold ${rejecting ? "bg-rose-600 text-white hover:bg-rose-500" : "border border-rose-500/50 text-rose-400 hover:bg-rose-500/10"} disabled:opacity-60`}>
          {busy === "reject" ? "Rejecting…" : rejecting ? "Confirm reject" : "✗ Reject"}
        </button>
        {err && <span className="text-xs text-red-400">⚠ {err}</span>}
      </div>
    </div>
  );
}
