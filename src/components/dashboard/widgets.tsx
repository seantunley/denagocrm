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
      duration: 0.6,
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
      variants={{ show: { transition: { staggerChildren: 0.035 } } }}
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
        hidden: { opacity: 0, y: 4 },
        show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
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

export function StatSparkCard({ stat, icon }: { stat: SparkStat; icon: React.ReactNode }) {
  const up = (stat.delta ?? 0) >= 0;
  const fmt = stat.display === "zar" ? zarCompact : undefined;

  return (
    <Link
      href={stat.href}
      className="group block min-w-0 rounded-xl px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:px-3"
    >
      <div className="flex items-center gap-2">
        <span className={cn("text-muted-foreground/55 [&_svg]:size-3.5", stat.tone === "warn" && "text-amber-400")}>{icon}</span>
        <p className="truncate text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">{stat.label}</p>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <p className="text-[1.85rem] font-semibold leading-none tracking-[-0.04em] text-foreground sm:text-[2.15rem]">
          <CountUp value={stat.value} format={fmt} />
        </p>
        {stat.delta !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn("mb-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums", up ? "text-emerald-400" : "text-red-400")}>
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

  if (total === 0) return <p className="py-2 text-sm text-muted-foreground">No open leads yet.</p>;

  return (
    <Link href="/leads" className="group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{totalValue}</p>
          <p className="mt-1 text-xs text-muted-foreground">{total} active {total === 1 ? "lead" : "leads"}</p>
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          View pipeline <ArrowRight className="size-3.5" />
        </span>
      </div>

      <div className="mb-4 flex h-1.5 w-full gap-1 overflow-hidden rounded-full bg-background/55" aria-hidden="true">
        {active.map((segment) => (
          <span key={segment.name} className="h-full min-w-1 rounded-full" style={{ background: segment.color, flexGrow: segment.count, flexBasis: 0 }} />
        ))}
      </div>

      <div className="space-y-1">
        {segments.map((segment) => (
          <div key={segment.name} className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <div className="flex min-w-0 items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: segment.color }} />
              <span className="truncate text-muted-foreground">{segment.name}</span>
            </div>
            <span className="font-semibold tabular-nums text-foreground">{segment.count}</span>
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
    <div className="py-2.5">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-foreground">{def.label}</p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
            {def.target > 0 ? `${fmt(def.actual)} / ${fmt(def.target)}` : "No target set"}
          </p>
        </div>
        {def.target > 0 && <span className={cn("text-xs font-semibold tabular-nums", hit ? "text-emerald-400" : "text-foreground")}>{Math.round(raw * 100)}%</span>}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-background/65">
        {def.target > 0 && (
          <motion.div
            className={cn("h-full rounded-full", hit && "bg-emerald-400")}
            style={hit ? undefined : { background: def.color }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
      </div>
    </div>
  );
}

export function TargetRings({ rings }: { rings: RingDef[] }) {
  const anySet = rings.some((ring) => ring.target > 0);

  if (!anySet) {
    return (
      <div className="py-2">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <TargetIcon className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">No targets set</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Add monthly goals to make this section useful.</p>
            <Link href="/targets" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">
              Set targets <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <div className="divide-y divide-border/30">{rings.map((ring) => <TargetRow key={ring.label} def={ring} />)}</div>;
}
