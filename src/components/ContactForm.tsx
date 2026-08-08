import type { LucideIcon } from "lucide-react";
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
import { NO_FLEET_PICKER, type FleetPicker } from "@/lib/fleetTypes";
import { contactKind } from "@/lib/contactKind";
import { cn } from "@/lib/utils";

type ContactDefaults = {
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

function FormSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b border-border bg-muted/20 px-4 py-4 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function ContactForm({
  action,
  defaults = {},
  submitLabel,
  users = [],
  fleetPicker = NO_FLEET_PICKER,
  variant = "compact",
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
      className={cn(
        "space-y-4",
        variant === "compact" && "card max-w-3xl",
        isPage && "min-w-0 space-y-5",
      )}
    >
      {(isPage || isDialog) && (
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(135deg,rgba(234,88,12,.12),rgba(255,255,255,.015)_55%)] p-4 sm:p-5">
          <div className="pointer-events-none absolute -right-12 -top-16 size-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <UserRound className="size-5" />
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Customer profile</p>
              <p className="mt-1 text-sm font-medium text-foreground">Start with the details you know.</p>
              <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
                Only a name is required. Contact, location and ownership details make follow-up and future service much easier.
              </p>
            </div>
          </div>
        </div>
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
        {users.length > 0 && (
          <Field label="Responsible owner">
            <select name="ownerId" className="input" defaultValue={defaults.ownerId ?? ""}>
              <option value="">Unassigned</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </Field>
        )}
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

      <div
        className={cn(
          "flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-3 shadow-sm",
          isPage && "sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 sm:static sm:p-4",
          isDialog && "sticky bottom-0 z-20 -mx-5 -mb-5 rounded-b-none border-x-0 border-b-0 bg-[#111412]/95 px-5 backdrop-blur-xl sm:-mx-6 sm:-mb-6 sm:px-6",
        )}
      >
        <p className="hidden text-xs text-muted-foreground sm:block">Fields marked * are required.</p>
        <ContactSubmitButton label={submitLabel} />
      </div>
    </SaveForm>
  );
}
