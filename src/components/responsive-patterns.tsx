import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ResponsiveDataView({
  mobile,
  desktop,
  className,
}: {
  mobile: ReactNode;
  desktop: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="sm:hidden">{mobile}</div>
      <div className="hidden sm:block">{desktop}</div>
    </div>
  );
}

export function MobileDataList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-border overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</div>;
}

/**
 * A semantic table on desktop that becomes a deliberate labelled record list
 * on phones. Cells opt into their mobile role with data-label, data-primary,
 * and data-actions attributes instead of relying on global table rewrites.
 */
export function ResponsiveEntityTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="responsive-entity-table" className={cn("overflow-x-auto rounded-xl border border-border bg-card", className)}>
      {children}
    </div>
  );
}

export function MobileDataCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <article className={cn("space-y-2.5 p-3.5", className)}>{children}</article>;
}

export function MobileDataHeader({
  title,
  detail,
  aside,
}: {
  title: ReactNode;
  detail?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2.5">
      <div className="min-w-0">
        <div className="font-semibold tracking-tight text-foreground">{title}</div>
        {detail && <div className="mt-0.5 text-xs leading-[1.125rem] text-muted-foreground">{detail}</div>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

export function MobileDataFields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-2 gap-x-3 gap-y-2.5", className)}>{children}</dl>;
}

export function MobileDataField({
  label,
  children,
  wide = false,
}: {
  label: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-2.5 xl:grid-cols-4", className)}>{children}</div>;
}

export function StickyActionArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/95 p-2.5 shadow-[0_-12px_35px_rgba(0,0,0,.22)] backdrop-blur-xl sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
