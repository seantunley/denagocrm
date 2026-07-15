"use client";

import { useState } from "react";
import {
  CalendarDays,
  CarFront,
  Fingerprint,
  Gauge,
  Palette,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import {
  CaptureField,
  CaptureFooter,
  CaptureHero,
  CaptureSection,
  type CaptureFormVariant,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";

export type VehicleFormProduct = {
  id: string;
  name: string;
  colors: string[];
};

type VehicleDefaults = {
  contactId?: string;
  productId?: string | null;
  model?: string;
  vin?: string | null;
  regNumber?: string | null;
  color?: string | null;
  purchaseDate?: string | null;
  warrantyMonths?: number | null;
  serviceIntervalKm?: number | null;
  serviceIntervalMonths?: number | null;
  notes?: string | null;
};

export default function VehicleForm({
  action,
  contacts,
  products,
  defaults = {},
  submitLabel,
  showInitialKm = false,
  variant = "compact",
}: {
  action: (formData: FormData) => Promise<void>;
  contacts: { id: string; label: string }[];
  products: VehicleFormProduct[];
  defaults?: VehicleDefaults;
  submitLabel: string;
  showInitialKm?: boolean;
  variant?: CaptureFormVariant;
}) {
  const [contactId, setContactId] = useState(defaults.contactId ?? "");
  const [productId, setProductId] = useState(defaults.productId ?? "");
  const [model, setModel] = useState(defaults.model ?? "");
  const [color, setColor] = useState(defaults.color ?? "");
  const [initialKm, setInitialKm] = useState("");
  const [serviceKm, setServiceKm] = useState(String(defaults.serviceIntervalKm ?? 1000));
  const [serviceMonths, setServiceMonths] = useState(String(defaults.serviceIntervalMonths ?? 6));
  const product = products.find((item) => item.id === productId);
  const owner = contacts.find((item) => item.id === contactId);

  function onProductChange(id: string) {
    setProductId(id);
    setColor("");
    const selected = products.find((item) => item.id === id);
    if (selected) setModel(selected.name);
  }

  return (
    <form
      action={action}
      className={cn("space-y-4", variant === "compact" && "card max-w-3xl", variant === "page" && "min-w-0 space-y-5")}
    >
      {(variant === "page" || variant === "dialog") && (
        <CaptureHero
          icon={CarFront}
          eyebrow="Customer garage"
          title={model.trim() || "Register a customer vehicle"}
          description="Connect the physical vehicle to its owner, then establish its identity, warranty and service baseline."
          summary={[
            { label: "Customer", value: owner?.label ?? "Choose owner" },
            { label: "Current mileage", value: initialKm.trim() ? `${Number(initialKm).toLocaleString()} km` : "Not recorded" },
            { label: "Service cadence", value: `${serviceKm || "—"} km / ${serviceMonths || "—"} mo` },
          ]}
        />
      )}

      <CaptureSection
        icon={UserRound}
        title="Owner & model"
        description="Link the vehicle to the correct customer and select a catalogue model where possible."
      >
        <CaptureField label="Customer *" wide>
          <select name="contactId" className="input" required value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">Select customer…</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>{contact.label}</option>
            ))}
          </select>
        </CaptureField>
        <CaptureField label="Catalogue product">
          <select name="productId" className="input" value={productId} onChange={(event) => onProductChange(event.target.value)}>
            <option value="">Custom / other model</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </CaptureField>
        <CaptureField label="Vehicle model *">
          <input
            name="model"
            className="input"
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Model name"
          />
        </CaptureField>
        <CaptureField label="Colour" wide>
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
              <input name="color" className="input pl-10" value={color} onChange={(event) => setColor(event.target.value)} placeholder="Vehicle colour" />
            </div>
          )}
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Fingerprint}
        title="Vehicle identity"
        description="Record the identifiers used for service, warranty, stock and legal documentation."
      >
        <CaptureField label="VIN / serial number">
          <input
            name="vin"
            className="input font-mono uppercase"
            autoCapitalize="characters"
            defaultValue={defaults.vin ?? ""}
            onChange={(event) => { event.target.value = event.target.value.toUpperCase(); }}
            placeholder="Manufacturer identifier"
          />
        </CaptureField>
        <CaptureField label="Registration number">
          <input
            name="regNumber"
            className="input uppercase"
            autoCapitalize="characters"
            defaultValue={defaults.regNumber ?? ""}
            onChange={(event) => { event.target.value = event.target.value.toUpperCase(); }}
            placeholder="e.g. CA 123-456"
          />
        </CaptureField>
        <CaptureField label="Purchase / delivery date">
          <div className="relative">
            <CalendarDays className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input type="date" name="purchaseDate" className="input pl-10" defaultValue={defaults.purchaseDate ?? ""} />
          </div>
        </CaptureField>
        <CaptureField label="Warranty term (months)">
          <input name="warrantyMonths" type="number" min={0} className="input tabular-nums" defaultValue={defaults.warrantyMonths ?? ""} placeholder="e.g. 24" />
        </CaptureField>
      </CaptureSection>

      <CaptureSection
        icon={Gauge}
        title="Service baseline"
        description="Set the recurring service cadence and the odometer reading this vehicle starts with."
      >
        <CaptureField label="Service every (km)">
          <input
            name="serviceIntervalKm"
            type="number"
            min={0}
            className="input tabular-nums"
            value={serviceKm}
            onChange={(event) => setServiceKm(event.target.value)}
          />
        </CaptureField>
        <CaptureField label="Service every (months)">
          <input
            name="serviceIntervalMonths"
            type="number"
            min={0}
            className="input tabular-nums"
            value={serviceMonths}
            onChange={(event) => setServiceMonths(event.target.value)}
          />
        </CaptureField>
        {showInitialKm && (
          <CaptureField label="Current mileage (km)" hint="This becomes the first mileage-history entry." wide>
            <input
              name="initialKm"
              type="number"
              min={0}
              className="input tabular-nums"
              value={initialKm}
              onChange={(event) => setInitialKm(event.target.value)}
              placeholder="0"
            />
          </CaptureField>
        )}
      </CaptureSection>

      <CaptureSection
        icon={ShieldCheck}
        title="Delivery & context"
        description="Choose the appropriate customer follow-up and leave useful context for sales and service teams."
      >
        {showInitialKm && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/40 p-3 sm:col-span-2">
            <input type="checkbox" name="newDelivery" className="mt-0.5 size-4 accent-orange-600" defaultChecked={Boolean(defaults.productId)} />
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Sparkles className="size-4 text-primary" />
                This is a new customer delivery
              </span>
              <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                Send the delivery survey and Google review request after registration.
              </span>
            </span>
          </label>
        )}
        <CaptureField label="Internal notes" wide>
          <textarea
            name="notes"
            className="input min-h-28 resize-y"
            rows={4}
            defaultValue={defaults.notes ?? ""}
            placeholder="Accessories, delivery context, service considerations or customer preferences"
          />
        </CaptureField>
      </CaptureSection>

      <CaptureFooter label={submitLabel} requiredNote="Customer and model are required." kind="vehicle" variant={variant} />
    </form>
  );
}
