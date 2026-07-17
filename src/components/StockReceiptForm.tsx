"use client";

import { useMemo, useState } from "react";
import { Boxes, ClipboardCheck, Coins, MapPin, PackageCheck } from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
} from "@/components/capture-form";

export type ReceiptLine = {
  id: string;
  productName: string;
  color: string | null;
  orderedQty: number;
  receivedQty: number;
  unitCostCents: number;
};

export type ReceiptLocation = {
  id: string;
  name: string;
  isDefault?: boolean;
};

type Entry = { lineId: string; qty: number; serials: string };

export default function StockReceiptForm({
  action,
  lines,
  locations,
}: {
  action: (formData: FormData) => Promise<void>;
  lines: ReceiptLine[];
  locations: ReceiptLocation[];
}) {
  const openLines = lines.filter((line) => line.receivedQty < line.orderedQty);
  const [entries, setEntries] = useState<Entry[]>(
    openLines.map((line) => ({ lineId: line.id, qty: 0, serials: "" })),
  );
  const totalQty = entries.reduce((sum, entry) => sum + Math.max(0, entry.qty), 0);
  const totalBase = useMemo(
    () => entries.reduce((sum, entry) => {
      const line = lines.find((item) => item.id === entry.lineId);
      return sum + Math.max(0, entry.qty) * ((line?.unitCostCents ?? 0) / 100);
    }, 0),
    [entries, lines],
  );
  const defaultLocation = locations.find((location) => location.isDefault)?.id ?? locations[0]?.id ?? "stock-location-yard";

  function update(lineId: string, patch: Partial<Entry>) {
    setEntries((current) => current.map((entry) => entry.lineId === lineId ? { ...entry, ...patch } : entry));
  }

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="receiptLines" value={JSON.stringify(entries)} />
      <CaptureHero
        icon={PackageCheck}
        eyebrow="Goods receipt"
        title="Receive physical units"
        description="Record only what actually arrived. Open balances remain on the purchase order for later partial receipts or backorders."
        summary={[
          { label: "Receiving now", value: totalQty },
          { label: "Open lines", value: openLines.length },
          { label: "Base value", value: `R ${totalBase.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
        ]}
      />

      <CaptureSection
        icon={ClipboardCheck}
        title="Receipt reference"
        description="Link the arrival to the supplier invoice, packing list or goods-received note."
      >
        <CaptureField label="Supplier invoice / GRN">
          <input name="receiptReference" className="input" placeholder="e.g. INV-20481 or GRN-18" />
        </CaptureField>
        <CaptureField label="Receiving location">
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <select name="locationId" className="input pl-10" defaultValue={defaultLocation}>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </div>
        </CaptureField>
        <CaptureField label="Receipt notes" wide>
          <textarea name="notes" className="input min-h-20 resize-y" placeholder="Condition, shortages, damaged packaging or supplier discrepancy" />
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Boxes}
        title="Quantities and serials"
        description="Serials are optional during receipt, but duplicate active identifiers are blocked. Enter one serial per line."
      >
        <div className="space-y-3 sm:col-span-2">
          {openLines.map((line) => {
            const entry = entries.find((item) => item.lineId === line.id)!;
            const remaining = line.orderedQty - line.receivedQty;
            return (
              <div key={line.id} className="rounded-2xl border border-border bg-background/30 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-medium text-foreground">{line.productName}{line.color ? ` · ${line.color}` : ""}</p>
                    <p className="text-xs text-muted-foreground">Ordered {line.orderedQty} · received {line.receivedQty} · open {remaining}</p>
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground">R {(line.unitCostCents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })} each</p>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
                  <div>
                    <label className="label">Receive now</label>
                    <input
                      type="number"
                      min="0"
                      max={remaining}
                      className="input tabular-nums"
                      value={entry.qty}
                      onChange={(event) => update(line.id, { qty: Math.min(remaining, Math.max(0, Number(event.target.value) || 0)) })}
                    />
                  </div>
                  <div>
                    <label className="label">Serial / VIN values</label>
                    <textarea
                      className="input min-h-24 resize-y font-mono text-xs uppercase"
                      value={entry.serials}
                      onChange={(event) => update(line.id, { serials: event.target.value.toUpperCase() })}
                      placeholder="One serial per line, or leave blank and capture later"
                    />
                  </div>
                </div>
              </div>
            );
          })}
          {openLines.length === 0 && (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-5 text-sm text-emerald-100">
              This purchase order has been fully received.
            </div>
          )}
        </div>
      </CaptureSection>

      <CaptureSection
        icon={Coins}
        title="Actual receiving overhead"
        description="Receipt-level freight, duties and handling are allocated across the units received now."
      >
        <CaptureField label="Freight (R)">
          <input name="freight" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <CaptureField label="Duties (R)">
          <input name="duties" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <CaptureField label="Other costs (R)">
          <input name="otherCosts" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
        </CaptureField>
        <div className="rounded-xl border border-primary/20 bg-primary/10 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">Receiving batch</p>
          <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">{totalQty} unit{totalQty === 1 ? "" : "s"}</p>
          <p className="mt-1 text-xs text-muted-foreground">Each unit receives a traceable goods-receipt movement and its calculated landed cost.</p>
        </div>
      </CaptureSection>

      {openLines.length > 0 && <CaptureFooter label="Receive into stock" requiredNote="At least one receive quantity must be greater than zero." kind="stock" variant="page" />}
    </form>
  );
}
