import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[10px] font-semibold uppercase tracking-[0.18em] text-primary", className)}>
      {children}
    </p>
  );
}

export function Surface({
  children,
  className,
  inset = false,
}: {
  children: ReactNode;
  className?: string;
  inset?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
        inset ? "bg-card/70" : "",
        className
      )}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PortalPageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-foreground">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  accent = false,
  className,
}: {
  icon: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group relative min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-white/15",
        className
      )}
    >
      {accent && <div className="pointer-events-none absolute -right-10 -top-12 size-28 rounded-full bg-primary/10 blur-2xl" />}
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-2 min-h-[2.5em] text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:min-h-0 sm:truncate">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground tabular-nums">{value}</p>
          {detail && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground sm:truncate">{detail}</p>}
        </div>
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl border", accent ? "border-primary/20 bg-primary/10 text-primary" : "border-border bg-muted/50 text-muted-foreground")}>
          <Icon className="size-[18px]" />
        </span>
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12 text-center", className)}>
      <span className="mx-auto grid size-12 place-items-center rounded-2xl border border-border bg-muted/40 text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  className?: string;
}) {
  const tones = {
    neutral: "border-border bg-muted/60 text-muted-foreground",
    success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    warning: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    danger: "border-red-400/20 bg-red-400/10 text-red-300",
    info: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  };

  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em]", tones[tone], className)}>
      {children}
    </span>
  );
}

export function FeedbackBanner({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: { icon: Info, style: "border-sky-400/20 bg-sky-400/10 text-sky-200" },
    success: { icon: CheckCircle2, style: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" },
    warning: { icon: AlertTriangle, style: "border-amber-400/20 bg-amber-400/10 text-amber-100" },
    danger: { icon: AlertCircle, style: "border-red-400/20 bg-red-400/10 text-red-200" },
  };
  const { icon: Icon, style } = tones[tone];
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", style, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1 text-xs leading-5 opacity-80">{children}</div>}
      </div>
    </div>
  );
}

export function PageSkeleton({ variant = "dashboard" }: { variant?: "dashboard" | "list" | "form" | "builder" }) {
  if (variant === "builder") {
    return (
      <div className="space-y-3" aria-label="Loading builder" role="status">
        <div className="h-14 animate-pulse rounded-2xl border border-border bg-card" />
        <div className="grid min-h-[65vh] gap-3 md:grid-cols-[15rem_minmax(0,1fr)_18rem]">
          <div className="hidden animate-pulse rounded-2xl border border-border bg-card md:block" />
          <div className="animate-pulse rounded-2xl border border-border bg-muted/40" />
          <div className="hidden animate-pulse rounded-2xl border border-border bg-card md:block" />
        </div>
        <span className="sr-only">Loading builder</span>
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div className="space-y-5" aria-label="Loading records" role="status">
        <div className="space-y-2"><div className="h-7 w-44 animate-pulse rounded-lg bg-muted" /><div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted/70" /></div>
        <div className="h-12 animate-pulse rounded-2xl border border-border bg-card" />
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-20 animate-pulse bg-muted/20" />)}
        </div>
        <span className="sr-only">Loading records</span>
      </div>
    );
  }

  if (variant === "form") {
    return (
      <div className="mx-auto max-w-3xl space-y-5" aria-label="Loading form" role="status">
        <div className="h-8 w-52 animate-pulse rounded-lg bg-muted" />
        {[0, 1, 2].map((section) => <div key={section} className="h-40 animate-pulse rounded-2xl border border-border bg-card" />)}
        <span className="sr-only">Loading form</span>
      </div>
    );
  }

  return (
    <div className="space-y-6" aria-label="Loading page" role="status">
      <div className="space-y-2">
        <div className="h-7 w-48 animate-pulse rounded-lg bg-muted" />
        <div className="h-4 w-full max-w-lg animate-pulse rounded bg-muted/70" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl border border-border bg-card" />)}
      </div>
      <div className="h-72 animate-pulse rounded-2xl border border-border bg-card" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
