"use client";

/**
 * A CLIENT component, like every one of its six sibling capture forms
 * (LeadForm, PartForm, ProductForm, VehicleForm, StockUnitForm,
 * StockPurchaseOrderForm).
 *
 * It was the one that never carried the directive, and that was not a
 * deliberate difference — it is the only consumer of `capture-form` that ran on
 * the server, so it was the only one passing `icon={MessageSquareText}` (a
 * FUNCTION) across the server→client boundary into `CaptureSection`. React
 * refuses that: "Functions cannot be passed directly to Client Components".
 * Six of those errors were thrown on every render of a contact page, one per
 * CaptureSection.
 *
 * Nothing here needs a server: no `await`, no database, no `server-only`
 * import, and all four of its children (SaveForm, DuplicateGuard,
 * ContactKindFields, ContactSubmitButton) are already client components.
 * QuickCreateDialog — itself a client component — already imports this file, so
 * it was in the client bundle regardless; the directive only makes that
 * consistent, rather than depending on which parent happened to pull it in.
 *
 * The `action` prop stays a server action, which is allowed to cross the
 * boundary and is exactly what the sibling forms already do.
 */

import type { ActionResult } from "@/lib/actionResultTypes";
import { SaveForm } from "@/components/SaveForm";
import {
  AtSign,
  MapPin,
  MessageSquareText,
  ShieldCheck,
  Tags,
  UserRound,
} from "lucide-react";
import DuplicateGuard from "@/components/DuplicateGuard";
import ContactSubmitButton from "@/components/ContactSubmitButton";
import ContactKindFields from "@/components/ContactKindFields";
import {
  CaptureField as Field,
  CaptureFooter,
  CaptureHero,
  CaptureSection as FormSection,
} from "@/components/capture-form";
import { NO_FLEET_PICKER, type FleetPicker } from "@/lib/fleetTypes";
import { contactKind } from "@/lib/contactKind";
import { cn } from "@/lib/utils";

type ContactDefaults = {
  /** Present when EDITING. See the offlineOperation comment below. */
  id?: string;
  isCompany?: boolean;
  fleetId?: string | null;
  vatNumber?: string | null;
  firstName?: string;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  source?: string | null;
  notes?: string | null;
  tags?: string;
  ownerId?: string | null;
  marketingOptOut?: boolean;
};

type ContactFormVariant = "compact" | "dialog" | "page";

export default function ContactForm({
  action,
  defaults = {},
  submitLabel,
  users = [],
  fleetPicker = NO_FLEET_PICKER,
  variant = "compact",
  offlineRecordId,
  offlineBaseVersion,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  defaults?: ContactDefaults;
  submitLabel: string;
  users?: { id: string; name: string }[];
  /**
   * The fleets this USER may link a contact to. Resolved by the calling page,
   * which checks both the fleet permission and the tenant (see
   * lib/fleetDirectory.ts) — this component renders whatever it is handed and
   * does no lookup of its own. Defaulting to "may not link, none listed" means a
   * call site that forgets it offers nothing, rather than everything.
   */
  fleetPicker?: FleetPicker;
  variant?: ContactFormVariant;
  offlineRecordId?: string;
  offlineBaseVersion?: string;
}) {
  const isPage = variant === "page";
  const isDialog = variant === "dialog";
  // Which of the three options an EXISTING contact is showing, derived from the
  // two columns that hold it — never re-worked out inline. See lib/contactKind.ts.
  const kind = contactKind(defaults);

  return (
    <SaveForm
      action={action}
      success={submitLabel.toLowerCase().includes("create") ? "Contact created" : "Contact saved"}
      // The form is REPLACED on success — create redirects, edit re-renders with
      // the saved values — so clearing it here would only blank fields the person
      // is still looking at.
      resetOnSuccess={false}
      /*
        The same rule as LeadForm, for the same reason: a missing record id is
        not evidence of a create. An edit whose offline identity was never passed
        offers NO offline operation, so SaveForm refuses rather than queueing a
        duplicate contact under the wrong verb. Every edit call site here does
        pass it today -- this is what keeps that true.
      */
      offlineOperation={
        defaults.id && !offlineRecordId
          ? undefined
          : {
              type: offlineRecordId ? "contact.update" : "contact.create",
              recordId: offlineRecordId,
              baseVersion: offlineBaseVersion,
            }
      }
      className={cn(
        "space-y-4",
        variant === "compact" && "card max-w-3xl",
        isPage && "min-w-0 space-y-5",
      )}
    >
      {(isPage || isDialog) && (
        <CaptureHero
          icon={UserRound}
          eyebrow="Customer profile"
          title="Start with the details you know."
          description="Only a name is required. Contact, location and ownership details make follow-up and future service much easier."
        />
      )}

      <FormSection
        icon={UserRound}
        title="Identity"
        description="Choose the customer type and capture the name people will recognise."
      >
        <ContactKindFields
          picker={fleetPicker}
          defaultKind={kind}
          defaultCompany={defaults.company}
          defaultFleetId={defaults.fleetId}
          defaultVatNumber={defaults.vatNumber}
        >
          <Field label="First name / account name *">
            <input
              name="firstName"
              className="input"
              required
              autoComplete="given-name"
              defaultValue={defaults.firstName ?? ""}
              placeholder="e.g. Sean or Cape Town Golf Club"
            />
          </Field>
          <Field label="Last name">
            <input name="lastName" className="input" autoComplete="family-name" defaultValue={defaults.lastName ?? ""} />
          </Field>
        </ContactKindFields>
      </FormSection>

      <FormSection
        icon={AtSign}
        title="Communication"
        description="Add at least one reliable channel for sales and service follow-up."
      >
        <Field label="Email address">
          <input
            name="email"
            type="email"
            className="input"
            autoComplete="email"
            inputMode="email"
            defaultValue={defaults.email ?? ""}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="Mobile / phone">
          <input
            name="phone"
            type="tel"
            className="input"
            autoComplete="tel"
            inputMode="tel"
            defaultValue={defaults.phone ?? ""}
            placeholder="+27 82 000 0000"
          />
        </Field>
        <Field label="WhatsApp number" hint="Leave blank when it is the same as the mobile number." wide>
          <input
            name="whatsapp"
            type="tel"
            className="input"
            inputMode="tel"
            defaultValue={defaults.whatsapp ?? ""}
            placeholder="Dedicated WhatsApp number, if different"
          />
        </Field>
      </FormSection>

      <FormSection
        icon={MessageSquareText}
        title="Ownership & origin"
        description="Route the relationship to the right person and record where it began."
      >
        {/*
          The owner field is ALWAYS rendered. It used to be `users.length > 0 &&`,
          which was harmless while the list was every User row on the platform and
          therefore never empty. Now that it is the staff of one workspace, empty
          is reachable — and a control that silently disappears is the worst
          reading of it: "Responsible owner" vanishing between two visits looks
          like the form has lost a field, or like the contact has lost its owner,
          rather than like a team with nobody assignable in it.

          Disabled rather than a <select> with no options, which is a broken-
          looking empty box that explains nothing. Disabled submits no value,
          which is exactly what the hidden field submitted, so the empty state
          changes what is SHOWN and not what is SAVED: `resolveAssignableUser`
          reads a blank `ownerId` as a deliberate "Unassigned". It carries no
          `name` for the same reason — a name would start submitting a value that
          no member backs.

          The second way a scoped list bites is on the EDIT form: the current
          owner may no longer be in it, and a `defaultValue` matching no option
          makes the browser select the FIRST one, so an ordinary save would hand
          the contact to whoever sorts first alphabetically — a wrong owner that
          looks like a deliberate choice. Falling back to the blank option gives
          that case somewhere honest to land, and the action refuses the id
          anyway if it is ever posted.
        */}
        <Field label="Responsible owner">
          {users.length === 0 ? (
            <select className="input" disabled defaultValue="">
              <option value="">No assignable team members — this contact will be left unassigned</option>
            </select>
          ) : (
            <select
              name="ownerId"
              className="input"
              defaultValue={users.some((user) => user.id === defaults.ownerId) ? defaults.ownerId ?? "" : ""}
            >
              <option value="">Unassigned</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Source">
          <select name="source" className="input" defaultValue={defaults.source ?? ""}>
            <option value="">Not specified</option>
            <option value="manual">Manual capture</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="website">Website</option>
            <option value="referral">Referral</option>
            <option value="walk-in">Walk-in</option>
          </select>
        </Field>
      </FormSection>

      <FormSection
        icon={MapPin}
        title="Location"
        description="Useful for delivery planning, service collection and territory reporting."
      >
        <Field label="Street address / estate & unit" wide>
          <input
            name="address"
            className="input"
            autoComplete="street-address"
            defaultValue={defaults.address ?? ""}
            placeholder="e.g. 12 Fairway Drive, De Zalze Golf Estate"
          />
        </Field>
        <Field label="Suburb">
          <input name="suburb" className="input" defaultValue={defaults.suburb ?? ""} />
        </Field>
        <Field label="City / town">
          <input name="city" className="input" autoComplete="address-level2" defaultValue={defaults.city ?? ""} />
        </Field>
        <Field label="Province">
          <select name="province" className="input" autoComplete="address-level1" defaultValue={defaults.province ?? ""}>
            <option value="">Select province</option>
            <option>Western Cape</option>
            <option>Eastern Cape</option>
            <option>Northern Cape</option>
            <option>Gauteng</option>
            <option>KwaZulu-Natal</option>
            <option>Free State</option>
            <option>North West</option>
            <option>Limpopo</option>
            <option>Mpumalanga</option>
          </select>
        </Field>
        <Field label="Postal code">
          <input
            name="postalCode"
            className="input"
            autoComplete="postal-code"
            inputMode="numeric"
            defaultValue={defaults.postalCode ?? ""}
          />
        </Field>
      </FormSection>

      <FormSection
        icon={Tags}
        title="Context & preferences"
        description="Add useful context for the next person who works with this customer."
      >
        <Field label="Tags" hint="Separate tags with commas, for example: VIP, Estate, Fleet." wide>
          <input
            name="tags"
            className="input"
            defaultValue={defaults.tags ?? ""}
            placeholder="VIP, Estate, Fleet"
          />
        </Field>
        <Field label="Internal notes" wide>
          <textarea
            name="notes"
            className="input min-h-28 resize-y"
            rows={4}
            defaultValue={defaults.notes ?? ""}
            placeholder="Preferences, relationship context or anything the team should know"
          />
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-background/40 p-3 sm:col-span-2">
          <input
            type="checkbox"
            name="marketingOptOut"
            defaultChecked={defaults.marketingOptOut ?? false}
            className="mt-0.5 size-4 accent-orange-600"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="size-4 text-muted-foreground" />
              Exclude from marketing campaigns
            </span>
            <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
              Transactional service messages remain available; bulk email and SMS are disabled.
            </span>
          </span>
        </label>
      </FormSection>

      <DuplicateGuard />

      <CaptureFooter variant={variant} requiredNote="Fields marked * are required.">
        <ContactSubmitButton label={submitLabel} />
      </CaptureFooter>
    </SaveForm>
  );
}
