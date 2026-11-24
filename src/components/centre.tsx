import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Surface } from "@/components/visual-system";
import { cn } from "@/lib/utils";

/**
 * The working screens' shared layout (My Work, Sales Centre, Deals Centre, the
 * deal page, the Command Centre — Sean's mockups, 2026-11-24): a title with its
 * actions, a row of headline numbers, a main worklist beside a side panel, and
 * summary cards below. Built from the CRM's own Surface and MetricCard, so the
 * screens look like the rest of the app.
 */

export function CentreHeader({ title, description, note, actions }: { title: string; description: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.035em]">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {note && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 text-primary" />
            {note}
          </span>
        )}
        {actions}
      </div>
    </div>
  );
}

/** The headline numbers: MetricCards, four across on a computer, two on a phone. */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{children}</div>;
}

/** Main list beside its side panel; the panel drops below on narrower screens. */
export function CentreMain({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">{children}</div>
      <div className="min-w-0">{aside}</div>
    </div>
  );
}

/** The summary cards along the bottom. */
export function CentreCards({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-3">{children}</div>;
}

export function Panel({
  icon: Icon,
  title,
  description,
  action,
  children,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Surface className={cn("p-4", className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
        </div>
        {action && <div className="shrink-0 text-xs">{action}</div>}
      </div>
      {children}
    </Surface>
  );
}

export type ViewChip = { key: string; label: string; href: string; count?: number; hint?: string };

/** The list's views as tabs, each with how many it holds. */
export function ViewChips({ label, chips, active }: { label: string; chips: ViewChip[]; active: string }) {
  return (
    <nav className="mb-3 flex flex-wrap gap-2" aria-label={label}>
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          title={chip.hint}
          aria-current={chip.key === active ? "page" : undefined}
          className={cn(
            "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
            chip.key === active ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          {chip.label}
          {chip.count !== undefined && <span className="ml-1 tabular-nums">({chip.count})</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A short list row inside a summary card: title, detail, and something on the right. */
export function CardRow({ href, title, detail, aside }: { href: string; title: ReactNode; detail?: ReactNode; aside?: ReactNode }) {
  return (
    <Link href={href} className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {aside && <span className="shrink-0 text-xs">{aside}</span>}
    </Link>
  );
}

/** Nothing to show in a card: say so in one line rather than leaving it blank. */
export function CardEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-xs text-muted-foreground">{children}</p>;
}
