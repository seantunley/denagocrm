"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import CaptureSubmitButton, { type CaptureKind } from "@/components/CaptureSubmitButton";
import { cn } from "@/lib/utils";

export type CaptureFormVariant = "compact" | "dialog" | "page";

export function CaptureHero({
  icon: Icon,
  eyebrow,
  title,
  description,
  summary = [],
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: ReactNode;
  description: ReactNode;
  summary?: { label: string; value: ReactNode }[];
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[linear-gradient(135deg,rgba(234,88,12,.13),rgba(255,255,255,.015)_58%)] p-4 sm:p-5">
      <div className="pointer-events-none absolute -right-12 -top-16 size-40 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{description}</p>
          {summary.length > 0 && (
            <div className={cn("mt-3 grid gap-2 text-xs", summary.length >= 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2")}>
              {summary.map((item, index) => (
                <div
                  key={item.label}
                  className={cn(
                    "rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2",
                    summary.length >= 3 && index === summary.length - 1 && "col-span-2 sm:col-span-1",
                  )}
                >
                  <span className="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</span>
                  <span className="mt-1 block truncate font-medium text-foreground">{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function CaptureSection({
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

export function CaptureField({
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
  // Associate the caption with its control so clicking the label focuses the
  // field and screen readers pair them. Only safe for a single native control;
  // icon-wrapped inputs and radio groups keep the caption as a visible label.
  const fieldId = useId();
  const asElement = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
  const canAssociate =
    asElement !== null &&
    typeof asElement.type === "string" &&
    ["input", "select", "textarea"].includes(asElement.type) &&
    asElement.props.id === undefined;

  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <label className="label" htmlFor={canAssociate ? fieldId : undefined}>{label}</label>
      {canAssociate && asElement ? cloneElement(asElement, { id: fieldId }) : children}
      {hint && <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CaptureFooter({
  label,
  requiredNote,
  kind,
  variant,
}: {
  label: string;
  requiredNote: string;
  kind: CaptureKind;
  variant: CaptureFormVariant;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-3 shadow-sm",
        variant === "page" && "sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 sm:static sm:p-4",
        variant === "dialog" && "sticky bottom-0 z-20 -mx-5 -mb-5 rounded-b-none border-x-0 border-b-0 bg-[#111412]/95 px-5 backdrop-blur-xl sm:-mx-6 sm:-mb-6 sm:px-6",
      )}
    >
      <p className="hidden text-xs text-muted-foreground sm:block">{requiredNote}</p>
      <CaptureSubmitButton label={label} kind={kind} />
    </div>
  );
}
