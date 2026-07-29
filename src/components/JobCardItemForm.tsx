"use client";

import { useState } from "react";
import { Clock3, Package, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";

type PartOption = { id: string; name: string; priceCents: number; stockQty: number };

export default function JobCardItemForm({
  action,
  parts,
}: {
  /**
   * NOT `=> void`. TypeScript lets a value-returning function satisfy a
   * void-returning signature, so a `=> void` prop silently accepts a converted
   * action — and the `{ error }` it returns is then dropped on the floor,
   * exactly the silent failure the conversion exists to prevent. Typing the
   * result makes the compiler enforce that this form handles it.
   */
  action: (formData: FormData) => Promise<ActionResult | void>;
  parts: PartOption[];
}) {
  const [kind, setKind] = useState<"part" | "labour">("part");
  const [partId, setPartId] = useState("");
  const [description, setDescription] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const selectedPart = parts.find((part) => part.id === partId);

  function pickPart(id: string) {
    setPartId(id);
    const part = parts.find((candidate) => candidate.id === id);
    setDescription(part?.name ?? "");
    setUnitPrice(part ? (part.priceCents / 100).toFixed(2) : "");
  }

  function changeKind(nextKind: "part" | "labour") {
    setKind(nextKind);
    setPartId("");
    setDescription("");
    setUnitPrice("");
  }

  return (
    <SaveForm
      action={action}
      success="Line added"
      onSaved={() => { setPartId(""); setDescription(""); setUnitPrice(""); }}
      className="rounded-2xl border border-border bg-muted/20 p-4"
    >
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="partId" value={kind === "part" ? partId : ""} />
      <input type="hidden" name="description" value={description} />

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Add a charge</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Parts update stock; labour remains a service line.</p>
        </div>
        <div className="flex rounded-lg border border-border bg-background p-1">
          <button type="button" onClick={() => changeKind("part")} className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium", kind === "part" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><Package className="size-3.5" />Part</button>
          <button type="button" onClick={() => changeKind("labour")} className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium", kind === "labour" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}><Clock3 className="size-3.5" />Labour</button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_5rem_8rem_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="job-item-description">{kind === "part" ? "Part / description" : "Labour description"}</label>
          {kind === "part" && parts.length > 0 ? (
            <>
              <select id="job-item-description" className="input" value={partId} onChange={(event) => pickPart(event.target.value)}>
                <option value="">Custom part…</option>
                {parts.map((part) => <option key={part.id} value={part.id}>{part.name} · {part.stockQty} in stock</option>)}
              </select>
              {!selectedPart && <input className="input mt-2" required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Custom part description" />}
              {selectedPart && selectedPart.stockQty <= 2 && <p className="mt-1 text-[11px] text-amber-300">Low stock: {selectedPart.stockQty} remaining</p>}
            </>
          ) : (
            <input id="job-item-description" className="input" required value={description} onChange={(event) => setDescription(event.target.value)} placeholder={kind === "labour" ? "Diagnostic, installation, service…" : "Part description"} />
          )}
        </div>
        <div>
          <label className="label" htmlFor="job-item-qty">Qty</label>
          <input id="job-item-qty" name="qty" className="input" defaultValue="1" inputMode="decimal" required />
        </div>
        <div>
          <label className="label" htmlFor="job-item-price">Unit price</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
            <input id="job-item-price" name="unitPrice" className="input pl-7" inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} placeholder="0.00" />
          </div>
        </div>
        <SaveButton pendingLabel="Adding…" className="btn-primary h-9 w-full sm:w-auto"><Plus className="size-4" />Add line</SaveButton>
      </div>
    </SaveForm>
  );
}
