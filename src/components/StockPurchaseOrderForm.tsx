"use client";

import { useMemo, useState } from "react";
import { Plus, ShoppingCart, Trash2 } from "lucide-react";
import { createPurchaseOrder } from "@/app/actions/stock";
import { CaptureField, CaptureFooter, CaptureHero, CaptureSection } from "@/components/capture-form";

type Product = { id: string; name: string; colors: string[] };
type Line = { id: string; productId: string; color: string; qty: number; cost: string; freight: string; notes: string };

const blankLine = (): Line => ({
  id: crypto.randomUUID(),
  productId: "",
  color: "",
  qty: 1,
  cost: "",
  freight: "",
  notes: "",
});

export default function StockPurchaseOrderForm({ products }: { products: Product[] }) {
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const totalUnits = lines.reduce((sum, line) => sum + Math.max(0, line.qty || 0), 0);
  const estimated = useMemo(() => lines.reduce((sum, line) => {
    const unit = Number(line.cost) || 0;
    const freight = Number(line.freight) || 0;
    return sum + unit * Math.max(0, line.qty || 0) + freight;
  }, 0), [lines]);

  const update = (id: string, patch: Partial<Line>) => setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  const serialised = JSON.stringify(lines.map(({ id: _id, ...line }) => line));

  return (
    <form action={createPurchaseOrder} className="space-y-5">
      <input type="hidden" name="lines" value={serialised} />
      <CaptureHero
        icon={ShoppingCart}
        eyebrow="Supplier purchasing"
        title="Create a multi-line purchase order"
        description="Order several models and colours together, track expected delivery, and receive the units through inspection."
        summary={[
          { label: "Lines", value: lines.length },
          { label: "Units", value: totalUnits },
          { label: "Estimated", value: `R ${estimated.toLocaleString("en-ZA", { minimumFractionDigits: 2 })}` },
        ]}
      />

      <CaptureSection title="Order details" description="Supplier-facing reference and expected arrival information." icon={ShoppingCart}>
        <CaptureField label="Supplier *"><input name="supplier" className="input" defaultValue="Denago" required /></CaptureField>
        <CaptureField label="Supplier order reference"><input name="reference" className="input" placeholder="PO / order number" /></CaptureField>
        <CaptureField label="Expected delivery"><input name="expectedAt" type="date" className="input" /></CaptureField>
        <CaptureField label="Internal notes"><input name="notes" className="input" placeholder="Shipping, payment or allocation context" /></CaptureField>
      </CaptureSection>

      <CaptureSection
        title="Order lines"
        description="Each line creates individually traceable incoming units."
        icon={Plus}
      >
        <div className="space-y-3 sm:col-span-2">
          {lines.map((line, index) => {
            const product = products.find((item) => item.id === line.productId);
            return (
              <div key={line.id} className="rounded-2xl border border-border bg-background/35 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">Line {index + 1}</p>
                  {lines.length > 1 && (
                    <button type="button" className="btn-ghost btn-sm text-red-300" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}>
                      <Trash2 className="size-4" /> Remove
                    </button>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="xl:col-span-2">
                    <label className="label">Model *</label>
                    <select className="input" value={line.productId} onChange={(event) => update(line.id, { productId: event.target.value, color: "" })} required>
                      <option value="">Choose model…</option>
                      {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Colour</label>
                    {product?.colors.length ? (
                      <select className="input" value={line.color} onChange={(event) => update(line.id, { color: event.target.value })}>
                        <option value="">Not specified</option>
                        {product.colors.map((color) => <option key={color} value={color}>{color}</option>)}
                      </select>
                    ) : (
                      <input className="input" value={line.color} onChange={(event) => update(line.id, { color: event.target.value })} placeholder="Colour" />
                    )}
                  </div>
                  <div><label className="label">Quantity *</label><input className="input" type="number" min={1} max={200} value={line.qty} onChange={(event) => update(line.id, { qty: Number(event.target.value) })} required /></div>
                  <div><label className="label">Unit cost (R)</label><input className="input" inputMode="decimal" value={line.cost} onChange={(event) => update(line.id, { cost: event.target.value })} placeholder="0.00" /></div>
                  <div><label className="label">Freight / line (R)</label><input className="input" inputMode="decimal" value={line.freight} onChange={(event) => update(line.id, { freight: event.target.value })} placeholder="0.00" /></div>
                  <div className="md:col-span-2"><label className="label">Line notes</label><input className="input" value={line.notes} onChange={(event) => update(line.id, { notes: event.target.value })} /></div>
                </div>
              </div>
            );
          })}
          <button type="button" className="btn-secondary btn-sm" onClick={() => setLines((current) => [...current, blankLine()])}>
            <Plus className="size-4" /> Add another line
          </button>
        </div>
      </CaptureSection>

      <CaptureFooter label="Create purchase order" requiredNote="At least one model and quantity are required." kind="stock" variant="dialog" />
    </form>
  );
}
