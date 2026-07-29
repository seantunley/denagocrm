"use client";

import { useMemo, useState, type ReactNode } from "react";
import { SaveForm } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";
import type { LucideIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";

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
  stageId?: string;
  contactId?: string | null;
  notes?: string | null;
  quantity?: number;
  assignedToId?: string | null;
};

type LeadFormVariant = "compact" | "dialog" | "page";

function FormSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
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
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  products: LeadFormProduct[];
  stages: { id: string; name: string }[];
  contacts: { id: string; label: string }[];
  defaults?: LeadDefaults;
  submitLabel: string;
  users?: { id: string; name: string }[];
  variant?: LeadFormVariant;
}) {
  const [name, setName] = useState(defaults.name ?? "");
  const [contactId, setContactId] = useState(defaults.contactId ?? "");
  const [productId, setProductId] = useState(defaults.productId ?? "");
  const [color, setColor] = useState(defaults.color ?? "");
  const [qty, setQty] = useState(Math.max(1, defaults.quantity ?? 1));
  const [value, setValue] = useState(defaults.valueCents ? String(defaults.valueCents / 100) : "");
  const [stageId, setStageId] = useState(defaults.stageId ?? stages[0]?.id ?? "");
  const product = products.find((item) => item.id === productId);
  const stage = stages.find((item) => item.id === stageId);
  const isPage = variant === "page";
  const isDialog = variant === "dialog";

  const snapshot = useMemo(
    () => ({
      customer: name.trim() || "New prospect",
      interest: product?.name ?? "Model undecided",
      value: formatPreviewValue(value),
    }),
    [name, product, value],
  );

  function onContactChange(id: string) {
    setContactId(id);
    const contact = contacts.find((item) => item.id === id);
    if (contact && !name.trim()) setName(contact.label);
  }

  function onProductChange(id: string) {
    setProductId(id);
    setColor("");
    const selected = products.find((item) => item.id === id);
    if (selected && selected.basePriceCents > 0) {
      setValue(String((selected.basePriceCents / 100) * qty));
    }
  }

  function onQtyChange(raw: string) {
    const next = Math.max(1, parseInt(raw, 10) || 1);
    setQty(next);
    if (product && product.basePriceCents > 0) {
      setValue(String((product.basePriceCents / 100) * next));
    }
  }

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
      {(isPage || isDialog) && (
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(135deg,rgba(234,88,12,.13),rgba(255,255,255,.015)_58%)] p-4 sm:p-5">
          <div className="pointer-events-none absolute -right-12 -top-16 size-40 rounded-full bg-primary/10 blur-3xl" />
          <div className="relative flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Opportunity snapshot</p>
              <p className="mt-1 truncate text-sm font-semibold text-foreground">{snapshot.customer}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2">
                  <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Interest</span>
                  <span className="mt-1 block truncate font-medium text-foreground">{snapshot.interest}</span>
                </div>
                <div className="rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2">
                  <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Pipeline</span>
                  <span className="mt-1 block truncate font-medium text-foreground">{stage?.name ?? "Choose stage"}</span>
                </div>
                <div className="col-span-2 rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2 sm:col-span-1">
                  <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Estimated value</span>
                  <span className="mt-1 block truncate font-medium text-foreground">{snapshot.value}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <FormSection
        icon={CircleUserRound}
        title="Customer"
        description="Identify the prospect and connect this opportunity to an existing profile when possible."
      >
        <Field
          label="Link an existing contact"
          hint="Selecting a contact links the lead to their customer timeline."
          wide
        >
          <select name="contactId" className="input" value={contactId} onChange={(event) => onContactChange(event.target.value)}>
            <option value="">New prospect — create a contact automatically</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>{contact.label}</option>
            ))}
          </select>
        </Field>
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
      </FormSection>

      <FormSection
        icon={Gauge}
        title="Vehicle interest"
        description="Choose a model and preference; catalogue pricing keeps the opportunity value in sync."
      >
        <Field label="Product / model">
          <select name="productId" className="input" value={productId} onChange={(event) => onProductChange(event.target.value)}>
            <option value="">Model undecided</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </Field>
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
        <Field
          label={`Estimated opportunity value (R)${qty > 1 && product ? ` — ${qty} × catalogue price` : ""}`}
          hint={product?.basePriceCents ? "Changing the model or quantity updates this value; you can still override it." : "Enter the best current estimate. It can be refined later."}
          wide
        >
          <div className="relative">
            <BadgeDollarSign className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="value"
              className="input pl-10 tabular-nums"
              inputMode="decimal"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="0.00"
            />
          </div>
        </Field>
      </FormSection>

      <FormSection
        icon={Route}
        title="Pipeline routing"
        description="Place the lead in the right stage, record its source and choose who owns the next action."
      >
        <Field label="Pipeline stage">
          <select name="stageId" className="input" value={stageId} onChange={(event) => setStageId(event.target.value)} required>
            {stages.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </Field>
        {users.length > 0 && (
          <Field label="Assigned to">
            <select name="assignedToId" className="input" defaultValue={defaults.assignedToId ?? ""}>
              <option value="">Assign to me automatically</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </Field>
        )}
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
        <Field label="Referral code" hint="Only needed when another customer referred this prospect.">
          <input name="referralCode" className="input uppercase" placeholder="DGO-XXXX" maxLength={12} />
        </Field>
      </FormSection>

      <FormSection
        icon={MessageSquareText}
        title="Opportunity context"
        description="Give the team a useful headline and the context needed for the first follow-up."
      >
        <Field label="Deal title" hint="Leave blank to build the title automatically from the model and colour." wide>
          <input
            name="title"
            className="input"
            defaultValue={defaults.title ?? ""}
            placeholder={product ? `${product.name}${color ? ` — ${color}` : ""}` : "Auto-generated when saved"}
          />
        </Field>
        <Field label="Internal notes" wide>
          <textarea
            name="notes"
            className="input min-h-32 resize-y"
            rows={5}
            defaultValue={defaults.notes ?? ""}
            placeholder="What matters to this customer? Timing, use case, budget, trade-in or next step…"
          />
        </Field>
      </FormSection>

      <DuplicateGuard />

      <div
        className={cn(
          "flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-3 shadow-sm",
          isPage && "sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 sm:static sm:p-4",
          isDialog && "sticky bottom-0 z-20 -mx-5 -mb-5 rounded-b-none border-x-0 border-b-0 bg-[#111412]/95 px-5 backdrop-blur-xl sm:-mx-6 sm:-mb-6 sm:px-6",
        )}
      >
        <p className="hidden text-xs text-muted-foreground sm:block">Customer name and pipeline stage are required.</p>
        <LeadSubmitButton label={submitLabel} />
      </div>
    </SaveForm>
  );
}
