"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Building2, UserRound, Warehouse } from "lucide-react";
import {
  CONTACT_KINDS,
  CONTACT_KIND_HINTS,
  CONTACT_KIND_LABELS,
  capturesVatNumber,
  type ContactKind,
} from "@/lib/contactKind";
import type { FleetPicker } from "@/lib/fleetTypes";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<ContactKind, typeof UserRound> = {
  individual: UserRound,
  business: Building2,
  fleet: Warehouse,
};

/**
 * Mirrors the `Field` wrapper in ContactForm — same label, hint and grid classes.
 * It is repeated rather than imported because ContactForm imports THIS file, and
 * importing back the other way would be a cycle.
 */
function Field({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The customer-type selector and the fields that depend on it.
 *
 * Three options — individual, business, fleet — written to the two columns that
 * already exist (`isCompany` + `fleetId`); see lib/contactKind.ts for the mapping
 * and for why `isCompany` was not turned into an enum. This component only ever
 * submits the CHOICE (`contactKind`) and, for a fleet, the chosen fleet's id: the
 * server derives the columns, and reads the company name off the fleet it
 * resolved inside the caller's own tenant, so the browser never gets to assert
 * which fleet a contact belongs to by name.
 *
 * Client-side because the fields genuinely change with the choice — the free-text
 * company box becomes a list of real fleets, and VAT only exists for a company.
 * The name fields sit between the selector and the company field in the layout,
 * so they are passed straight through as `children` and stay server-rendered.
 */
export default function ContactKindFields({
  picker,
  defaultKind,
  defaultCompany,
  defaultFleetId,
  defaultVatNumber,
  children,
}: {
  picker: FleetPicker;
  defaultKind: ContactKind;
  defaultCompany?: string | null;
  defaultFleetId?: string | null;
  defaultVatNumber?: string | null;
  children?: ReactNode;
}) {
  const [kind, setKind] = useState<ContactKind>(defaultKind);
  const { canLink, fleets } = picker;

  return (
    <>
      <fieldset className="sm:col-span-2">
        <legend className="label">Customer type</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {CONTACT_KINDS.map((option) => {
            const Icon = KIND_ICONS[option];
            return (
              <label
                key={option}
                className="group cursor-pointer rounded-xl border border-border bg-background/40 p-3 transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10"
              >
                <input
                  type="radio"
                  name="contactKind"
                  value={option}
                  checked={kind === option}
                  onChange={() => setKind(option)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon className="size-4 text-muted-foreground group-has-[:checked]:text-primary" />
                  {CONTACT_KIND_LABELS[option]}
                </span>
                <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                  {CONTACT_KIND_HINTS[option]}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {children}

      {kind === "fleet" ? (
        <Field
          label="Fleet"
          wide
          hint={
            canLink && fleets.length > 0
              ? "The fleet account this person belongs to. Its name becomes their company, and their records roll up onto the fleet."
              : undefined
          }
        >
          {canLink && fleets.length > 0 ? (
            <select name="fleetId" className="input" required defaultValue={defaultFleetId ?? ""}>
              <option value="" disabled>
                Select a fleet…
              </option>
              {fleets.map((fleet) => (
                <option key={fleet.id} value={fleet.id}>
                  {fleet.name}
                </option>
              ))}
            </select>
          ) : canLink ? (
            <p className="rounded-xl border border-dashed border-border bg-background/40 p-3 text-xs leading-5 text-muted-foreground">
              No fleets exist yet.{" "}
              <Link href="/fleets" className="text-primary hover:underline">
                Create a fleet
              </Link>{" "}
              first, then come back and link this person to it.
            </p>
          ) : (
            <>
              {/*
                No fleet permission. The dropdown is not rendered, so this record
                keeps the fleet it already has instead of quietly losing it on
                save — the server accepts an unchanged fleet id from a caller who
                may not browse fleets, and refuses a different one. With no
                existing fleet there is nothing to submit and the save is refused
                with a message, which is the honest outcome.
              */}
              {defaultFleetId && <input type="hidden" name="fleetId" value={defaultFleetId} />}
              <p className="rounded-xl border border-dashed border-border bg-background/40 p-3 text-xs leading-5 text-muted-foreground">
                {defaultFleetId
                  ? "You do not have access to fleet accounts, so this person's fleet cannot be changed here. Saving keeps them on their current fleet."
                  : "You do not have access to fleet accounts. Ask an administrator to link this person to a fleet."}
              </p>
            </>
          )}
        </Field>
      ) : (
        <Field label="Company" wide>
          <input
            name="company"
            className="input"
            autoComplete="organization"
            defaultValue={defaultCompany ?? ""}
            placeholder="Optional employer, business or fleet name"
          />
        </Field>
      )}

      {capturesVatNumber(kind) && (
        <Field
          label="VAT number"
          hint="Shown on quotes and invoices addressed to this business."
        >
          <input
            name="vatNumber"
            className="input"
            defaultValue={defaultVatNumber ?? ""}
            placeholder="e.g. 4123456789"
          />
        </Field>
      )}

      {kind === "fleet" && (
        <Field label="VAT number" wide>
          {/*
            Not an input. A fleet member's VAT number is the FLEET's — one number
            on the business entity a quote would be addressed to. A second copy
            here is a copy free to drift from it.
          */}
          <p className="rounded-xl border border-dashed border-border bg-background/40 p-3 text-xs leading-5 text-muted-foreground">
            Captured on the fleet account itself, along with its registration
            number and billing address.
          </p>
        </Field>
      )}
    </>
  );
}
