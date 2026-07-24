import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Surface } from "@/components/visual-system";
import { cn } from "@/lib/utils";

export type WorkspaceStat = {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
};

const STAT_TONES = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-red-300",
};

export function WorkspaceHero({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  stats = [],
  className,
}: {
  icon: LucideIcon;
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  stats?: WorkspaceStat[];
  className?: string;
}) {
  return (
    <Surface className={cn("relative overflow-hidden border-primary/15 bg-gradient-to-br from-primary/[0.12] via-card to-card", className)}>
      <div className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
              <Icon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.04em] text-foreground sm:text-[28px]">{title}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
            </div>
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
        </div>

        {stats.length > 0 ? (
          <div className={cn(
            "mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70",
            stats.length === 1 && "sm:grid-cols-1",
            stats.length === 2 && "sm:grid-cols-2",
            stats.length === 3 && "sm:grid-cols-3",
            stats.length >= 4 && "sm:grid-cols-4",
          )}>
            {stats.map((stat, index) => {
              const StatIcon = stat.icon;
              return <div key={index} className="min-w-0 bg-background/55 px-4 py-3 backdrop-blur-sm">
                <p className="flex items-center gap-1.5 truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{StatIcon ? <StatIcon className="size-3 shrink-0" /> : null}{stat.label}</p>
                <p className={cn("mt-1 text-lg font-semibold tracking-[-0.03em] tabular-nums", STAT_TONES[stat.tone ?? "default"])}>{stat.value}</p>
                {stat.detail ? <p className="mt-0.5 truncate text-[10px] text-muted-foreground/80">{stat.detail}</p> : null}
              </div>;
            })}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}
