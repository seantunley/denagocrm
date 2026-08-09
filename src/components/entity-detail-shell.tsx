import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type DetailFact = {
  label: ReactNode;
  value: ReactNode;
};

export function EntityDetailShell({
  backHref,
  backLabel,
  eyebrow,
  title,
  status,
  description,
  meta,
  facts = [],
  actions,
  children,
  className,
}: {
  backHref: string;
  backLabel: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  facts?: DetailFact[];
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-4", className)}>
      <header className="relative overflow-hidden rounded-xl border border-border bg-card p-3.5 shadow-sm sm:p-4">
        <div className="pointer-events-none absolute -right-16 -top-20 size-48 rounded-full bg-primary/10 blur-3xl" />
        <Link
          href={backHref}
          className="relative inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {backLabel}
        </Link>

        <div className="relative mt-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            {eyebrow && <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>}
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <h1 className="min-w-0 text-xl font-semibold tracking-[-0.04em] text-foreground sm:text-2xl">{title}</h1>
              {status}
            </div>
            {description && <div className="mt-1.5 max-w-3xl text-xs leading-5 text-muted-foreground">{description}</div>}
            {meta && <div className="mt-1 text-xs leading-5 text-muted-foreground/80">{meta}</div>}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border pt-3 lg:max-w-[58%] lg:justify-end lg:border-0 lg:pt-0">
              {actions}
            </div>
          )}
        </div>

        {facts.length > 0 && (
          <dl className="relative mt-3.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
            {facts.map((fact, index) => (
              <div key={index} className="min-w-0 bg-muted/35 px-2.5 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{fact.label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium text-foreground">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>
      {children}
    </div>
  );
}
