"use client";

import { useState } from "react";
import {
  BadgeDollarSign,
  BatteryCharging,
  CircleCheck,
  Fingerprint,
  Gauge,
  MapPin,
  PackagePlus,
  Palette,
} from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { SaveForm } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";
import { cn } from "@/lib/utils";

export type StockUnitProduct = {
  id: string;
  name: string;
  colors: string[];
};

export default function StockUnitForm({
  action,
  products,
  variant = "compact",
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  products: StockUnitProduct[];
  variant?: CaptureFormVariant;
}) {
  const [productId, setProductId] = useState("");
  const [color, setColor] = useState("");
  const [serial, setSerial] = useState("");
  const [cost, setCost] = useState("");
  const product = products.find((item) => item.id === productId);

  function onProductChange(id: string) {
    setProductId(id);
    setColor("");
  }

  return (
    <SaveForm
      action={action}
      success="Stock unit added"
      // form.reset() cannot reach these — they are controlled by useState, so
      // without this the model, colour and serial would survive a save.
      onSaved={() => {
        setProductId("");
        setColor("");
        setSerial("");
        setCost("");
      }}
      className={cn("space-y-4", variant === "compact" && "card max-w-3xl", variant === "page" && "min-w-0 space-y-5")}
    >
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={PackagePlus}
          eyebrow="Floor stock intake"
          title={product?.name ?? "Choose the Denago model"}
          description="Register one physical unit already on site with its identity, equipment, condition and valuation basis."
          summary={[
            { label: "State", value: "Available" },
            { label: "Identity", value: serial.trim() || "Serial pending" },
            { label: "Acquisition cost", value: cost.trim() ? `R ${cost}` : "Not recorded" },
          ]}
        />
      )}

      <CaptureSection
        icon={Gauge}
        title="Model & specification"
        description="Identify the catalogue model and the unit’s physical colour."
      >
        <CaptureField label="Product / model *" wide>
          <select name="productId" className="input" required value={productId} onChange={(event) => onProductChange(event.target.value)}>
            <option value="" disabled>Select model…</option>
            {products.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </CaptureField>
        <CaptureField label="Colour" hint="Use a catalogue colour where one is configured." wide>
          {product && product.colors.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-xl border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10 has-[:checked]:text-foreground">
                <input type="radio" name="color" value="" checked={!color} onChange={() => setColor("")} className="sr-only" />
                Not recorded
              </label>
              {product.colors.map((option) => (
                <label key={option} className="cursor-pointer rounded-xl border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10 has-[:checked]:text-foreground">
                  <input type="radio" name="color" value={option} checked={color === option} onChange={() => setColor(option)} className="sr-only" />
                  {option}
                </label>
              ))}
            </div>
          ) : (
            <div className="relative">
              <Palette className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="color" className="input pl-10" value={color} onChange={(event) => setColor(event.target.value)} placeholder="e.g. Matte black" />
            </div>
          )}
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Fingerprint}
        title="Unit identity & valuation"
        description="Serial data distinguishes this physical unit; acquisition cost supports inventory and margin reporting."
      >
        <CaptureField label="Serial / VIN" hint="Must be unique across active stock.">
          <input
            name="serial"
            className="input font-mono uppercase"
            autoCapitalize="characters"
            value={serial}
            onChange={(event) => setSerial(event.target.value.toUpperCase())}
            placeholder="Serial or VIN"
          />
        </CaptureField>
        <CaptureField label="Acquisition cost (R)">
          <div className="relative">
            <BadgeDollarSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input name="cost" className="input pl-10 tabular-nums" inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} placeholder="0.00" />
          </div>
        </CaptureField>
        <CaptureField label="Condition">
          <select name="condition" className="input" defaultValue="new">
            <option value="new">New</option>
            <option value="demo">Demo</option>
            <option value="used">Used</option>
            <option value="consignment">Consignment</option>
            <option value="damaged">Damaged</option>
          </select>
        </CaptureField>
        <CaptureField label="Odometer / km">
          <input name="odometerKm" type="number" min="0" className="input" placeholder="0" />
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={BatteryCharging}
        title="Supplied equipment"
        description="Capture the serialized equipment handed over with this cart."
      >
        <CaptureField label="Battery serial"><input name="batterySerial" className="input font-mono" placeholder="Battery identifier" /></CaptureField>
        <CaptureField label="Charger serial"><input name="chargerSerial" className="input font-mono" placeholder="Charger identifier" /></CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={MapPin}
        title="Availability & context"
        description="Choose the physical location and leave useful operational context."
      >
        <CaptureField label="Location" wide>
          <input name="location" className="input" placeholder="Showroom, warehouse, yard or branch" />
        </CaptureField>
        <div className="flex items-start gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3 sm:col-span-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-400/10 text-emerald-300"><CircleCheck className="size-4" /></span>
          <div>
            <p className="text-sm font-medium text-emerald-100">Available immediately</p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/70">The arrival time is recorded automatically and the unit becomes reservable for a matching open lead.</p>
          </div>
        </div>
        <CaptureField label="Internal notes" wide>
          <textarea name="notes" className="input min-h-28 resize-y" rows={4} placeholder="Condition, accessories, storage instructions or supplier context" />
        </CaptureField>
      </CaptureSection>

      <CaptureFooter label="Add to stock" requiredNote="A catalogue model is required." kind="stock" variant={variant} />
    </SaveForm>
  );
}
