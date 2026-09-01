"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { animate, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Target as TargetIcon, TrendingDown, TrendingUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setDisplay,
    });
    return () => controls.stop();
  }, [value, reduced]);

  const fmt = format ?? ((n: number) => String(Math.round(n)));
  return <span className="tabular-nums">{fmt(display)}</span>;
}

export function Stagger({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : "hidden"}
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.045 } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={{
        hidden: { opacity: 0, y: 6 },
        show: { opacity: 1, y: 0, transition: { duration: 0.22 } },
      }}
    >
      {children}
    </motion.div>
  );
}

export type SparkStat = {
  label: string;
  value: number;
  display?: "int" | "zar";
  delta: number | null;
  href: string;
  spark: number[];
  tone?: "default" | "warn";
};

const zarCompact = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `R${(n / 1_000_000).toFixed(1)}m`
    : Math.abs(n) >= 1_000
      ? `R${Math.round(n / 1_000)}k`
      : `R${Math.round(n)}`;

/**
 * KPI presentation deliberately avoids the old "card inside a card" look.
 * The number is the object; the chrome is recessive. Spark data stays on the
 * type because the loaders also use this component elsewhere, but the home KPI
 * strip no longer draws decorative charts that compete with the values.
 */
export function StatSparkCard({ stat, icon }: { stat: SparkStat; icon: React.ReactNode }) {
  const up = (stat.delta ?? 0) >= 0;
  const fmt = stat.display === "zar" ? zarCompact : undefined;

  return (
    <Link
      href={stat.href}
      className="group flex min-h-[112px] min-w-0 flex-col justify-between rounded-2xl border border-border/50 bg-card/30 px-4 py-4 transition-colors hover:border-border hover:bg-card/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:px-5"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-xs font-medium text-muted-foreground">{stat.label}</p>
        <span className="shrink-0 text-muted-foreground/65 transition-colors group-hover:text-primary [&_svg]:size-4">
          {icon}
        </span>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <p className="text-[1.8rem] font-semibold leading-none tracking-[-0.035em] text-foreground sm:text-[2rem]">
          <CountUp value={stat.value} format={fmt} />
        </p>
        {stat.delta !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "mb-0.5 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold tabular-nums",
                  up ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400",
                )}
              >
                {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                {Math.abs(stat.delta)}%
              </span>
            </TooltipTrigger>
            <TooltipContent>vs the same days last month</TooltipContent>
          </Tooltip>
        )}
      </div>
    </Link>
  );
}

export type PipeSeg = { name: string; color: string; count: number; value: number };

export function PipelineSnapshot({ segments, totalValue }: { segments: PipeSeg[]; totalValue: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const active = segments.filter((segment) => segment.count > 0);

  if (total === 0) {
    return <p className="py-3 text-sm text-muted-foreground">No open leads yet — new opportunities will appear here.</p>;
  }

  return (
    <Link href="/leads" className="group block focus-visible:outline-none">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="text-3xl font-semibold tracking-[-0.035em] text-foreground">{totalValue}</p>
          <p className="mt-1 text-xs text-muted-foreground">open pipeline · {total} active {total === 1 ? "lead" : "leads"}</p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          Open board <ArrowRight className="size-3.5" />
        </span>
      </div>

      <div className="mb-4 flex h-2.5 w-full gap-1 overflow-hidden rounded-full bg-muted/40" aria-hidden="true">
        {active.map((segment) => (
          <span
            key={segment.name}
            className="h-full min-w-1 rounded-full"
            style={{ background: segment.color, flexGrow: segment.count, flexBasis: 0 }}
          />
        ))}
      </div>

      <div className="space-y-1.5">
        {segments.map((segment) => (
          <div
            key={segment.name}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors group-hover:bg-muted/25"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: segment.color }} />
              <span className="truncate text-xs text-muted-foreground">{segment.name}</span>
            </div>
            <span className="text-xs font-semibold tabular-nums text-foreground">{segment.count}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}

export type RingDef = {
  label: string;
  actual: number;
  target: number;
  display: "int" | "zar";
  color: string;
};

function TargetRow({ def }: { def: RingDef }) {
  const raw = def.target > 0 ? def.actual / def.target : 0;
  const pct = Math.max(0, Math.min(100, Math.round(raw * 100)));
  const fmt = def.display === "zar" ? zarCompact : (n: number) => String(Math.round(n));
  const hit = def.target > 0 && def.actual >= def.target;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="rounded-xl px-1 py-2">
          <div className="mb-2 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{def.label}</p>
              <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                {def.target > 0 ? `${fmt(def.actual)} of ${fmt(def.target)}` : "No target set"}
              </p>
            </div>
            {def.target > 0 && (
              <span className={cn("text-xs font-semibold tabular-nums", hit ? "text-emerald-400" : "text-foreground")}>
                {Math.round(raw * 100)}%
              </span>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted/70">
            {def.target > 0 && (
              <motion.div
                className={cn("h-full rounded-full", hit && "bg-emerald-400")}
                style={hit ? undefined : { background: def.color }}
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
              />
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {def.target > 0 ? `${fmt(def.actual)} of ${fmt(def.target)} target` : "No target set for this month"}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Kept under the historical export name so custom dashboard configs and card
 * implementations do not change shape. Visually these are now compact progress
 * rows rather than four large empty rings.
 */
export function TargetRings({ rings }: { rings: RingDef[] }) {
  const anySet = rings.some((ring) => ring.target > 0);

  if (!anySet) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 bg-background/20 p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <TargetIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Set your monthly targets</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Track leads, sales, deliveries and services against a real goal instead of empty gauges.
            </p>
            <Link href="/targets" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              Set targets <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {rings.map((ring) => (
        <TargetRow key={ring.label} def={ring} />
      ))}
      <Link href="/targets" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        Manage targets <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}
