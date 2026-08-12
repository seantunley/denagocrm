import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Eyebrow, Surface } from "@/components/visual-system";
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

const HERO_TONES = {
  primary: {
    surface: "border-primary/15 bg-gradient-to-br from-primary/[0.12] via-card to-card",
    glow: "bg-primary/10",
    icon: "border-primary/20 bg-primary/10 text-primary",
    eyebrow: "text-primary",
    activeBorder: "border-primary",
  },
  marketing: {
    surface: "border-fuchsia-400/15 bg-gradient-to-br from-fuchsia-500/[0.1] via-card to-card",
    glow: "bg-fuchsia-400/10",
    icon: "border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300",
    eyebrow: "text-fuchsia-300",
    activeBorder: "border-fuchsia-300",
  },
};

export function WorkspaceHero({
  icon: Icon,
  eyebrow,
  title,
  description,
  actions,
  stats = [],
  navigation,
  tone = "primary",
  className,
}: {
  icon: LucideIcon;
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  stats?: WorkspaceStat[];
  navigation?: ReactNode;
  tone?: keyof typeof HERO_TONES;
  className?: string;
}) {
  const theme = HERO_TONES[tone];

  return (
    <Surface data-tone={tone} className={cn("relative overflow-hidden", theme.surface, className)}>
      <div className={cn("pointer-events-none absolute -right-24 -top-28 size-72 rounded-full blur-3xl", theme.glow)} />
      <div className="relative p-3.5 sm:px-4 sm:py-3.5">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-2.5 sm:items-center">
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg border shadow-sm sm:size-8", theme.icon)}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 xl:flex xl:items-center xl:gap-4">
              <div className="shrink-0">
                <Eyebrow className={theme.eyebrow}>{eyebrow}</Eyebrow>
                <h1 className="mt-0.5 text-lg font-semibold tracking-[-0.04em] text-foreground">{title}</h1>
              </div>
              <p className="mt-1 max-w-2xl text-xs leading-[1.125rem] text-muted-foreground xl:mt-0 xl:max-w-xl">{description}</p>
            </div>
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">{actions}</div> : null}
        </div>

        {stats.length > 0 ? (
          <div className={cn(
            "mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70",
            stats.length === 1 && "sm:grid-cols-1",
            stats.length === 2 && "sm:grid-cols-2",
            stats.length === 3 && "sm:grid-cols-3",
            stats.length >= 4 && "sm:grid-cols-4",
          )}>
            {stats.map((stat, index) => {
              const StatIcon = stat.icon;
              return <div key={index} className="min-w-0 bg-background/55 px-2.5 py-1.5 backdrop-blur-sm">
                <p className="flex items-center gap-1.5 truncate text-[10px] font-medium tracking-[0.02em] text-muted-foreground">{StatIcon ? <StatIcon className="size-3 shrink-0" /> : null}{stat.label}</p>
                <p className={cn("mt-0.5 text-sm font-semibold tracking-[-0.03em] tabular-nums", STAT_TONES[stat.tone ?? "default"])}>{stat.value}</p>
                {stat.detail ? <p className="truncate text-[9px] leading-4 text-muted-foreground/80">{stat.detail}</p> : null}
              </div>;
            })}
          </div>
        ) : null}
        {navigation ? (
          <div data-slot="workspace-navigation" data-active-border={theme.activeBorder} className="-mx-3.5 -mb-3.5 mt-2.5 border-t border-border/70 px-2.5 sm:-mx-4 sm:px-3">
            {navigation}
          </div>
        ) : null}
      </div>
    </Surface>
  );
}
