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
  return <div className={cn("divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card", className)}>{children}</div>;
}

export function MobileDataCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <article className={cn("space-y-3 p-4", className)}>{children}</article>;
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
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="font-semibold tracking-tight text-foreground">{title}</div>
        {detail && <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

export function MobileDataFields({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-3", className)}>{children}</dl>;
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
      <dd className="mt-1 min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 xl:grid-cols-4", className)}>{children}</div>;
}

export function StickyActionArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-20 -mx-1 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-background/95 p-3 shadow-[0_-12px_35px_rgba(0,0,0,.22)] backdrop-blur-xl sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
