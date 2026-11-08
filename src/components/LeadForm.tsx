"use client";

import { useMemo, useState } from "react";
import { currencySymbol } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { useCurrencies, useMoneyFormat } from "@/components/MoneyFormatProvider";
import { SaveForm } from "@/components/SaveForm";
import ContactPicker, { type ContactOption } from "@/components/ContactPicker";
import type { ActionResult } from "@/lib/actionResultTypes";
import {
  BadgeDollarSign,
  CircleUserRound,
  Gauge,
  MessageSquareText,
  Palette,
  Route,
  Sparkles,
} from "lucide-react";
import DuplicateGuard from "@/components/DuplicateGuard";
import LeadSubmitButton from "@/components/LeadSubmitButton";
import {
  CaptureField as Field,
  CaptureFooter,
  CaptureHero,
  CaptureSection as FormSection,
} from "@/components/capture-form";
import { cn } from "@/lib/utils";
import { FormDetailDisclosure } from "@/components/FormDetailDisclosure";
import { useFormDetailMode } from "@/hooks/useFormDetailMode";
import { defaultEntryStageId, type EntryStageOption } from "@/lib/createFormDetail";

export type LeadFormProduct = {
  id: string;
  name: string;
  basePriceCents: number;
  colors: string[];
};

type LeadDefaults = {
  title?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  source?: string;
  productId?: string | null;
  color?: string | null;
  valueCents?: number;
  /** The lead's currency (multicurrency module); null/undefined = the base. */
  currency?: string | null;
  stageId?: string;
  contactId?: string | null;
  notes?: string | null;
  quantity?: number;
  assignedToId?: string | null;
};

type LeadFormVariant = "compact" | "dialog" | "page";

/**
 * "full": every section open, as the edit dialog needs. "collapsible": the
 * create page — the fields most leads arrive with, then "Add more detail".
 */
type LeadFormDetail = "full" | "collapsible";

function formatPreviewValue(raw: string) {
  const numeric = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return "Value pending";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    maximumFractionDigits: 0,
  }).format(numeric);
}

export default function LeadForm({
  action,
  products,
  stages,
  contacts,
  defaults = {},
  submitLabel,
  users = [],
  variant = "compact",
  detail = "full",
  defaultPipelineId,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  products: LeadFormProduct[];
  stages: EntryStageOption[];
  contacts: { id: string; label: string }[];
  defaults?: LeadDefaults;
  submitLabel: string;
  users?: { id: string; name: string }[];
  variant?: LeadFormVariant;
  detail?: LeadFormDetail;
  /** Picks the stage a new lead defaults to when the list spans several pipelines. */
  defaultPipelineId?: string | null;
}) {
  const moneyFmt = useMoneyFormat();
  const [name, setName] = useState(defaults.name ?? "");
  const [contactId, setContactId] = useState(defaults.contactId ?? "");
  const [productId, setProductId] = useState(defaults.productId ?? "");
  const [color, setColor] = useState(defaults.color ?? "");
  const [qty, setQty] = useState(Math.max(1, defaults.quantity ?? 1));
  const [value, setValue] = useState(defaults.valueCents ? String(defaults.valueCents / 100) : "");
  // Multicurrency module: the lead's own currency. One option = the module is off; no picker, nothing posted.
  const currencies = useCurrencies();
  const [currency, setCurrency] = useState(defaults.currency || currencies[0]);
  const inBase = currency === currencies[0];
  const [currencyChanged, setCurrencyChanged] = useState(false);
  const valueFmt = withCurrency(moneyFmt, currency);
  const [stageId, setStageId] = useState(defaults.stageId ?? defaultEntryStageId(stages, defaultPipelineId));
  const product = products.find((item) => item.id === productId);
  // Colour is asked only of a workspace whose catalogue uses colours (a dealer's does; a service firm's doesn't),
  // or of a lead that already has one — an absent field saves as no colour, so hiding it would wipe it.
  const usesColours = products.some((item) => item.colors.length > 0) || Boolean(defaults.color);
  const stage = stages.find((item) => item.id === stageId);
  const isPage = variant === "page";
  const isDialog = variant === "dialog";
  const collapsible = detail === "collapsible";
  const [expanded, setExpanded] = useFormDetailMode("lead");
  const showDetail = !collapsible || expanded;

  const snapshot = useMemo(
    () => ({
      customer: name.trim() || "New prospect",
      interest: product?.name ?? "Not decided yet",
      value: formatPreviewValue(value),
    }),
    [name, product, value],
  );

  function onContactChange(id: string, contact: ContactOption | null) {
    setContactId(id);
    if (contact && !name.trim()) setName(contact.label);
  }

  function onProductChange(id: string) {
    setProductId(id);
    setColor("");
    const selected = products.find((item) => item.id === id);
    // The catalogue price is in the base currency: never fill it into a lead in another one.
    if (selected && selected.basePriceCents > 0 && inBase) {
      setValue(String((selected.basePriceCents / 100) * qty));
    }
  }

  /**
   * A value typed or priced in one currency is not the same number in another: R100 000 must
   * never quietly become US$100 000. Back to the base with a product → the catalogue price
   * again; anything else → the field empties and asks for the amount in the new currency.
   */
  function onCurrencyChange(code: string) {
    if (code === currency) return;
    setCurrency(code);
    if (code === currencies[0] && product && product.basePriceCents > 0) {
      setValue(String((product.basePriceCents / 100) * qty));
    } else {
      setValue("");
      setCurrencyChanged(true);
    }
  }

  function onQtyChange(raw: string) {
    const next = Math.max(1, parseInt(raw, 10) || 1);
    setQty(next);
    if (product && product.basePriceCents > 0 && inBase) {
      setValue(String((product.basePriceCents / 100) * next));
    }
  }

  const contactField = (
    <Field
      label="Link an existing contact"
      hint="Selecting a contact links the lead to their customer timeline."
      wide
    >
      <ContactPicker
        name="contactId"
        options={contacts}
        value={contactId}
        onChange={onContactChange}
        emptyLabel="New prospect — create a contact automatically"
      />
    </Field>
  );

  const nameField = (
    <Field label="Customer name *" wide>
      <input
        name="name"
        className="input"
        required
        autoComplete="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Who are we helping?"
      />
    </Field>
  );

  const emailField = (
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
  );

  const phoneField = (
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
  );

  const productField = (
    <Field label="Product">
      <select name="productId" className="input" value={productId} onChange={(event) => onProductChange(event.target.value)}>
        <option value="">Not decided yet</option>
        {products.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
    </Field>
  );

  const quantityField = (
    <Field label="Quantity">
      <input
        name="quantity"
        type="number"
        min={1}
        step={1}
        className="input"
        value={qty}
        onChange={(event) => onQtyChange(event.target.value)}
      />
    </Field>
  );

  const colourField = usesColours && (
    <Field label="Colour preference" wide>
      {product && product.colors.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <label className="cursor-pointer rounded-xl border border-border bg-background/40 px-3 py-2 text-xs text-muted-foreground transition-colors has-[:checked]:border-primary/45 has-[:checked]:bg-primary/10 has-[:checked]:text-foreground">
            <input type="radio" name="color" value="" checked={!color} onChange={() => setColor("")} className="sr-only" />
            No preference
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
          <input
            name="color"
            className="input pl-10"
            placeholder="Colour of interest"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </div>
      )}
    </Field>
  );

  const valueField = (
    <Field
      label={`Estimated opportunity value (${currencySymbol(valueFmt)})${qty > 1 && product && inBase ? ` — ${qty} × catalogue price` : ""}`}
      hint={product?.basePriceCents && inBase ? "Changing the model or quantity updates this value; you can still override it." : "Enter the best current estimate. It can be refined later."}
      wide
    >
      {currencies.length > 1 && (
        <select
          name="currency"
          aria-label="Currency"
          className="input mb-2 w-32"
          value={currency}
          onChange={(event) => onCurrencyChange(event.target.value)}
        >
          {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      )}
      <div className="relative">
        <BadgeDollarSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          name="value"
          className="input pl-10 tabular-nums"
          inputMode="decimal"
          value={value}
          onChange={(event) => { setValue(event.target.value); setCurrencyChanged(false); }}
          placeholder="0.00"
        />
      </div>
      {currencyChanged && !value && (
        <p role="status" className="mt-1.5 text-xs text-amber-500">Currency changed — enter the value in {currency}.</p>
      )}
    </Field>
  );

  // `required` only while visible: a folded, empty select would stop the submit
  // with a browser message pointing at a field nobody can see. (Empty is only
  // reachable in a workspace with no stages, which the server refuses anyway.)
  const stageField = (
    <Field label="Pipeline stage">
      <select name="stageId" className="input" value={stageId} onChange={(event) => setStageId(event.target.value)} required={showDetail}>
        {stages.map((item) => (
          // A won/lost stage cannot be created into; the server refuses it, so do not offer it.
          <option key={item.id} value={item.id} disabled={item.isClosed}>{item.name}</option>
        ))}
      </select>
    </Field>
  );

  // The field STAYS when there is nobody to list.
  //
  // It used to be rendered only for a non-empty list, which was harmless
  // while the list was every User row on the platform and therefore never
  // empty. Now that it is the staff of one workspace, empty is reachable —
  // and a control that silently disappears is the worst reading of it: the
  // person cannot tell an empty team from a form that has quietly dropped
  // the field, and "Assigned to" vanishing between two visits looks like
  // the lead lost its owner.
  //
  // Disabled rather than an empty dropdown, because a <select> with no
  // options is a broken-looking box that says nothing. Disabled submits no
  // value, which is exactly the same thing the hidden field submitted, so
  // what happens on save is unchanged: blank means "assign to me".
  const assigneeField = (
    <Field label="Assigned to">
      {users.length === 0 ? (
        <select className="input" disabled defaultValue="">
          <option value="">No assignable team members — this lead will be assigned to you</option>
        </select>
      ) : (
        <select name="assignedToId" className="input" defaultValue={defaults.assignedToId ?? ""}>
          <option value="">Assign to me automatically</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.name}</option>
          ))}
        </select>
      )}
    </Field>
  );

  const sourceField = (
    <Field label="Lead source">
      <select name="source" className="input" defaultValue={defaults.source ?? "manual"}>
        <option value="manual">Manual capture</option>
        <option value="facebook">Facebook</option>
        <option value="instagram">Instagram</option>
        <option value="website">Website</option>
        <option value="referral">Referral</option>
        <option value="walk-in">Walk-in</option>
      </select>
    </Field>
  );

  const referralField = (
    <Field label="Referral code" hint="Only needed when another customer referred this prospect.">
      <input name="referralCode" className="input uppercase" placeholder="The code on their customer record" maxLength={12} />
    </Field>
  );

  const titleField = (
    <Field label="Deal title" hint="Leave blank to build the title automatically from the model and colour." wide>
      <input
        name="title"
        className="input"
        defaultValue={defaults.title ?? ""}
        placeholder={product ? `${product.name}${color ? ` — ${color}` : ""}` : "Auto-generated when saved"}
      />
    </Field>
  );

  const notesField = (
    <Field label="Internal notes" wide>
      <textarea
        name="notes"
        className="input min-h-32 resize-y"
        rows={5}
        defaultValue={defaults.notes ?? ""}
        placeholder="What matters to this customer? Timing, use case, budget, trade-in or next step…"
      />
    </Field>
  );

  // The folded sections. Same groupings as the full form minus the essentials,
  // which the compact section already shows. The value is NOT folded: picking a
  // product fills it, and a figure that saves must be one the rep can see.
  const detailSections = (
    <>
      {colourField && (
        <FormSection icon={Gauge} title="Product interest" description="The colour the customer has in mind, if any.">
          {colourField}
        </FormSection>
      )}

      <FormSection
        icon={Route}
        title="Pipeline routing"
        description="Place the lead in a specific stage, or record who referred this prospect."
      >
        {stageField}
        {referralField}
      </FormSection>

      <FormSection
        icon={MessageSquareText}
        title="Opportunity context"
        description="Give the team a useful headline and the context needed for the first follow-up."
      >
        {titleField}
        {notesField}
      </FormSection>
    </>
  );

  return (
    <SaveForm
      action={action}
      success={submitLabel.toLowerCase().includes("create") ? "Lead created" : "Lead saved"}
      // Replaced on success — create redirects, edit re-renders with the saved
      // values — so a reset would only blank fields still on screen.
      resetOnSuccess={false}
      className={cn(
        "space-y-4",
        variant === "compact" && "card max-w-3xl",
        isPage && "min-w-0 space-y-5",
      )}
    >
      {/* Full form only: on the compact one it would mount above the fields when
          "Add more detail" is clicked below them and push the page down. */}
      {(isPage || isDialog) && !collapsible && (
        <CaptureHero
          icon={Sparkles}
          eyebrow="Opportunity snapshot"
          title={snapshot.customer}
          description="Capture the essentials now; the team can refine the opportunity as the conversation develops."
          summary={[
            { label: "Interest", value: snapshot.interest },
            { label: "Pipeline", value: stage?.name ?? "Choose stage" },
            { label: "Estimated value", value: snapshot.value },
          ]}
        />
      )}

      {collapsible ? (
        <>
          <FormSection
            icon={CircleUserRound}
            title="Essentials"
            description={`A name and a number are enough to start. The lead lands in ${stage?.name ?? "the first stage"} unless you choose otherwise.`}
          >
            {contactField}
            {nameField}
            {phoneField}
            {emailField}
            {productField}
            {quantityField}
            {valueField}
            {sourceField}
            {assigneeField}
          </FormSection>

          <FormDetailDisclosure
            expanded={expanded}
            onToggle={setExpanded}
            hint={`${usesColours ? "Colour, pipeline" : "Pipeline"} stage, referral code, deal title and notes.`}
          >
            {detailSections}
          </FormDetailDisclosure>
        </>
      ) : (
        <>
          <FormSection
            icon={CircleUserRound}
            title="Customer"
            description="Identify the prospect and connect this opportunity to an existing profile when possible."
          >
            {contactField}
            {nameField}
            {emailField}
            {phoneField}
          </FormSection>

          <FormSection
            icon={Gauge}
            title="Product interest"
            description="Choose what they're interested in; catalogue pricing keeps the opportunity value in sync."
          >
            {productField}
            {quantityField}
            {colourField}
            {valueField}
          </FormSection>

          <FormSection
            icon={Route}
            title="Pipeline routing"
            description="Place the lead in the right stage, record its source and choose who owns the next action."
          >
            {stageField}
            {assigneeField}
            {sourceField}
            {referralField}
          </FormSection>

          <FormSection
            icon={MessageSquareText}
            title="Opportunity context"
            description="Give the team a useful headline and the context needed for the first follow-up."
          >
            {titleField}
            {notesField}
          </FormSection>
        </>
      )}

      <DuplicateGuard />

      <CaptureFooter variant={variant} requiredNote={collapsible ? "Only the customer name is required." : "Customer name and pipeline stage are required."}>
        <LeadSubmitButton label={submitLabel} />
      </CaptureFooter>
    </SaveForm>
  );
}
