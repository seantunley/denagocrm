import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-medium tracking-[0.04em] text-primary", className)}>
      {children}
    </p>
  );
}

export function Surface({
  children,
  className,
  inset = false,
  level = "raised",
}: {
  children: ReactNode;
  className?: string;
  inset?: boolean;
  level?: "raised" | "base" | "inset";
}) {
  const resolvedLevel = inset ? "inset" : level;
  const levels = {
    raised: "bg-card shadow-[0_1px_2px_rgba(0,0,0,0.16)]",
    base: "bg-card/70",
    inset: "bg-background/35",
  };

  return (
    <section
      data-slot="surface"
      data-level={resolvedLevel}
      className={cn(
        "overflow-hidden rounded-xl border border-border",
        levels[resolvedLevel],
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
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-xs leading-[1.125rem] text-muted-foreground">{description}</p>}
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.045em] text-foreground">{title}</h1>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
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
        "group relative min-w-0 overflow-hidden rounded-xl border border-border bg-card p-3 shadow-sm transition-colors hover:border-white/15",
        className
      )}
    >
      {accent && <div className="pointer-events-none absolute -right-10 -top-12 size-28 rounded-full bg-primary/10 blur-2xl" />}
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-2 min-h-[2.25em] text-[11px] font-medium tracking-[0.02em] text-muted-foreground sm:min-h-0 sm:truncate">{label}</p>
          <p className="mt-1.5 text-xl font-semibold tracking-[-0.04em] text-foreground tabular-nums">{value}</p>
          {detail && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground sm:truncate">{detail}</p>}
        </div>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border", accent ? "border-primary/20 bg-primary/10 text-primary" : "border-border bg-muted/50 text-muted-foreground")}>
          <Icon className="size-4" />
        </span>
      </div>
    </div>
  );
}

export function MetricStrip({
  children,
  glow = "right",
  className,
}: {
  children: ReactNode;
  glow?: "left" | "right" | "none";
  className?: string;
}) {
  return (
    <section className={cn("relative overflow-hidden rounded-xl border border-border bg-card shadow-sm", className)}>
      {glow !== "none" && (
        <div
          className={cn(
            "pointer-events-none absolute -top-24 size-72 rounded-full bg-primary/[0.08] blur-3xl",
            glow === "left" ? "-left-20" : "-right-20",
          )}
        />
      )}
      <div className="relative grid grid-cols-2 gap-px bg-border [&>*]:rounded-none [&>*]:border-0 [&>*]:shadow-none lg:grid-cols-4">
        {children}
      </div>
    </section>
  );
}

export function WorkspaceToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card/70 p-2.5 shadow-sm", className)}>
      {children}
    </section>
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
    <div className={cn("rounded-xl border border-border/70 bg-muted/[0.14] px-5 py-8 text-center", className)}>
      <span className="mx-auto grid size-9 place-items-center rounded-lg bg-muted/60 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <h3 className="mt-3 text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
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
    /*
     * `shrink-0` and `whitespace-nowrap` are load-bearing, not decoration.
     *
     * A pill is nearly always the small right-hand item of a flex row whose
     * left-hand side is a heading and a paragraph. Without `shrink-0` flexbox
     * is free to shrink it below the width of its own text, and the text then
     * wraps — so "0 live" rendered as a tall green CIRCLE with the number above
     * the word, on the Chatbot page's Knowledge workspace card.
     *
     * Fixed here rather than at that one call site: every StatusPill in a flex
     * row has the same exposure, and a label that wraps has already stopped
     * being a pill.
     */
    <span data-slot="status-pill" data-tone={tone} className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", tones[tone], className)}>
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
      className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5", style, className)}
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
      <div data-slot="page-skeleton" data-variant="builder" className="space-y-3" aria-label="Loading builder" aria-busy="true" role="status">
        <Skeleton className="h-12 rounded-xl border border-border bg-card" />
        <div className="grid min-h-[65vh] gap-3 md:grid-cols-[15rem_minmax(0,1fr)_18rem]">
          <Skeleton className="hidden rounded-xl border border-border bg-card md:block" />
          <Skeleton className="rounded-xl border border-border bg-muted/40" />
          <Skeleton className="hidden rounded-xl border border-border bg-card md:block" />
        </div>
        <span className="sr-only">Loading builder</span>
      </div>
    );
  }

  if (variant === "list") {
    return (
      <div data-slot="page-skeleton" data-variant="list" className="space-y-4" aria-label="Loading records" aria-busy="true" role="status">
        <Skeleton className="h-24 rounded-xl border border-border bg-card" />
        <Skeleton className="h-10 rounded-xl border border-border bg-card/70" />
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2, 3, 4].map((item) => <Skeleton key={item} className="h-14 rounded-none bg-muted/20" />)}
        </div>
        <span className="sr-only">Loading records</span>
      </div>
    );
  }

  if (variant === "form") {
    return (
      <div data-slot="page-skeleton" data-variant="form" className="mx-auto max-w-3xl space-y-4" aria-label="Loading form" aria-busy="true" role="status">
        <Skeleton className="h-16 rounded-xl border border-border bg-card" />
        {[0, 1, 2].map((section) => <Skeleton key={section} className="h-32 rounded-xl border border-border bg-card" />)}
        <span className="sr-only">Loading form</span>
      </div>
    );
  }

  return (
    <div data-slot="page-skeleton" data-variant="dashboard" className="space-y-4" aria-label="Loading page" aria-busy="true" role="status">
      <Skeleton className="h-20 rounded-xl border border-border bg-card" />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <Skeleton key={item} className="h-20 rounded-xl border border-border bg-card" />)}
      </div>
      <Skeleton className="h-64 rounded-xl border border-border bg-card" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
