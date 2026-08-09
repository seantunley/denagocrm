import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function MobileOnly({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("lg:hidden", className)}>{children}</div>;
}

export function DesktopOnly({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("hidden lg:block", className)}>{children}</div>;
}

export function MobileWorkspaceHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-[-0.035em] text-foreground">{title}</h1>
        <p className="mt-0.5 max-w-sm text-xs leading-[1.125rem] text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function MobileStatPair({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; tone?: "default" | "attention" }>;
}) {
  return (
    <section className="grid grid-cols-2 gap-2">
      {items.slice(0, 2).map((item) => (
        <div key={item.label} className={cn("rounded-xl border border-border bg-card p-2.5", item.tone === "attention" && "border-amber-400/20 bg-amber-400/[0.06]")}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{item.label}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground">{item.value}</p>
        </div>
      ))}
    </section>
  );
}

export function MobileSegmentNav({
  items,
}: {
  items: Array<{ label: string; href: string; active?: boolean; count?: number }>;
}) {
  return (
    <nav className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card/70 p-1" aria-label="View options">
      {items.map((item) => (
        <Link key={`${item.href}-${item.label}`} href={item.href} aria-current={item.active ? "page" : undefined} className={cn("flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium", item.active ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
          {item.label}
          {typeof item.count === "number" && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] tabular-nums">{item.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function MobileSection({ title, detail, children }: { title: ReactNode; detail?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-3 px-0.5">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {detail && <span className="text-[11px] text-muted-foreground">{detail}</span>}
      </div>
      {children}
    </section>
  );
}

export function MobileTaskList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-card">{children}</div>;
}

export function MobileTaskCard({
  icon: Icon,
  title,
  detail,
  meta,
  aside,
  action,
  href,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  action?: ReactNode;
  href?: string;
}) {
  const content = (
    <div className="flex min-w-0 items-start gap-2.5 p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground"><Icon className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{title}</p>{detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}</div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
        {(meta || action) && <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2"><div className="min-w-0 text-[11px] text-muted-foreground">{meta}</div>{action && <div className="shrink-0">{action}</div>}</div>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block transition-colors active:bg-muted/30">{content}</Link> : <article>{content}</article>;
}
