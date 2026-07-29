"use client";

import { useState } from "react";

import { SaveForm, SaveButton } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";

type Line = {
  id: string;
  name: string;
  color: string | null;
  ordered: number;
  received: number;
  outstanding: number;
};

/**
 * Genuine partial receiving: pick how many of each still-outstanding line to receive.
 * Submits a `{ lineId: qty }` map to receivePurchaseOrder, which advances each line's
 * receivedQty and marks the PO "received" only when nothing is outstanding.
 */
export function StockReceiveForm({
  action,
  lines,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  lines: Line[];
}) {
  const receivable = lines.filter((l) => l.outstanding > 0);
  const done = lines.filter((l) => l.outstanding === 0);
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(receivable.map((l) => [l.id, l.outstanding])),
  );
  const map = Object.fromEntries(Object.entries(qty).filter(([, v]) => v > 0));
  const total = Object.values(map).reduce((s, v) => s + v, 0);

  return (
    <SaveForm action={action} success="Units received" resetOnSuccess={false} className="space-y-3">
      <input type="hidden" name="receiveLines" value={JSON.stringify(map)} />
      <p className="text-sm text-muted-foreground">
        Receive some or all outstanding units — the rest stay on backorder. Received units go to the
        inspection queue for serial capture.
      </p>
      <ul className="divide-y divide-border/50">
        {receivable.map((l) => (
          <li key={l.id} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{l.name}{l.color ? ` · ${l.color}` : ""}</p>
              <p className="text-xs text-muted-foreground">{l.received}/{l.ordered} received · {l.outstanding} outstanding</p>
            </div>
            <input
              type="number"
              min={0}
              max={l.outstanding}
              value={qty[l.id] ?? 0}
              onChange={(e) =>
                setQty((q) => ({ ...q, [l.id]: Math.max(0, Math.min(l.outstanding, Number(e.target.value) || 0)) }))
              }
              className="input w-20 text-right"
            />
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <p className="text-[11px] text-muted-foreground">{done.length} line{done.length === 1 ? "" : "s"} already fully received.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Receipt / waybill ref</label><input name="receiptReference" className="input" /></div>
        <div><label className="label">Notes</label><input name="notes" className="input" /></div>
      </div>
      <SaveButton className="btn-primary btn-sm" disabled={total === 0} pendingLabel="Receiving…">
        Receive {total} unit{total === 1 ? "" : "s"}
      </SaveButton>
    </SaveForm>
  );
}
