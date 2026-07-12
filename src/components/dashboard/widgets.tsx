"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { animate, motion, useReducedMotion } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { TrendingDown, TrendingUp, Target as TargetIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/* ── count-up number ─────────────────────────────────────────────── */

function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(reduced ? value : 0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      return;
    }
    const controls = animate(0, value, {
      duration: 0.9,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduced]);

  const fmt = format ?? ((n: number) => String(Math.round(n)));
  return (
    <span ref={ref} className="tabular-nums">
      {fmt(display)}
    </span>
  );
}

/* ── staggered entrance container ────────────────────────────────── */

export function Stagger({ children, className }: { children: React.ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : "hidden"}
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.06 } } }}
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
        hidden: { opacity: 0, y: 10 },
        show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 24 } },
      }}
    >
      {children}
    </motion.div>
  );
}

/* ── stat card with sparkline ────────────────────────────────────── */

export type SparkStat = {
  label: string;
  value: number;
  display?: "int" | "zar";
  delta: number | null; // % vs same days last month
  href: string;
  spark: number[]; // daily series
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
  const data = stat.spark.map((v, i) => ({ i, v }));
  const fmt = stat.display === "zar" ? zarCompact : undefined;
  const reduced = useReducedMotion();
  const cardRef = useRef<HTMLAnchorElement>(null);
  // Subtle 3D tilt toward the cursor — pure transform, zero re-renders
  function onMove(e: React.MouseEvent<HTMLAnchorElement>) {
    const el = cardRef.current;
    if (!el || reduced) return;
    const r = el.getBoundingClientRect();
    const rx = ((e.clientY - r.top) / r.height - 0.5) * -5;
    const ry = ((e.clientX - r.left) / r.width - 0.5) * 5;
    el.style.transform = `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-2px)`;
  }
  function onLeave() {
    if (cardRef.current) cardRef.current.style.transform = "";
  }
  return (
    <Link
      href={stat.href}
      ref={cardRef}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className="group relative block min-w-0 overflow-hidden rounded-xl border border-border bg-card p-4 shadow-sm transition-[transform,border-color,box-shadow] duration-150 will-change-transform hover:border-primary/40 hover:shadow-lg hover:shadow-black/20"
    >
      {/* sparkline sits behind the content, anchored to the bottom */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 opacity-60 transition-opacity group-hover:opacity-90">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`spark-${stat.label.replace(/\W/g, "")}`} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={stat.tone === "warn" ? "var(--warning)" : "var(--primary)"}
                  stopOpacity={0.3}
                />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={stat.tone === "warn" ? "var(--warning)" : "var(--primary)"}
              strokeWidth={1.5}
              strokeOpacity={0.7}
              fill={`url(#spark-${stat.label.replace(/\W/g, "")})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {stat.label}
          </p>
          <span
            className={cn(
              "shrink-0 [&_svg]:size-4",
              stat.tone === "warn" ? "text-amber-400" : "text-primary/70"
            )}
          >
            {icon}
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <p className="text-2xl font-semibold text-foreground">
            <CountUp value={stat.value} format={fmt} />
          </p>
          {stat.delta !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "flex cursor-default items-center gap-0.5 text-xs font-medium tabular-nums",
                    up ? "text-emerald-400" : "text-red-400"
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
      </div>
    </Link>
  );
}

/* ── pipeline snapshot: stacked stage bar ────────────────────────── */

export type PipeSeg = { name: string; color: string; count: number; value: number };

export function PipelineSnapshot({ segments, totalValue }: { segments: PipeSeg[]; totalValue: string }) {
  const reduced = useReducedMotion();
  const total = segments.reduce((s, x) => s + x.count, 0);
  if (total === 0) {
    return (
      <p className="py-3 text-xs text-muted-foreground/70">
        No open leads yet — new ones will appear here.
      </p>
    );
  }
  return (
    <Link href="/leads" className="group block">
      <div className="flex h-3.5 w-full gap-px overflow-hidden rounded-full">
        {segments
          .filter((s) => s.count > 0)
          .map((s, i) => (
            <Tooltip key={s.name}>
              <TooltipTrigger asChild>
                <motion.span
                  className="h-full transition-[filter] group-hover:brightness-110"
                  style={{ background: s.color }}
                  initial={reduced ? false : { flexBasis: 0 }}
                  animate={{ flexBasis: `${(s.count / total) * 100}%` }}
                  transition={{ duration: 0.7, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {s.name}: {s.count} lead{s.count === 1 ? "" : "s"}
              </TooltipContent>
            </Tooltip>
          ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.name}
            <span className="font-medium tabular-nums text-foreground">{s.count}</span>
          </span>
        ))}
        <span className="ml-auto text-[11px] font-medium tabular-nums text-muted-foreground">
          {totalValue} open
        </span>
      </div>
    </Link>
  );
}

/* ── target progress rings ───────────────────────────────────────── */

export type RingDef = {
  label: string;
  actual: number;
  target: number; // 0 = not set
  display: "int" | "zar";
  color: string;
};

function Ring({ def, index }: { def: RingDef; index: number }) {
  const reduced = useReducedMotion();
  const pctRaw = def.target > 0 ? def.actual / def.target : 0;
  const pct = Math.min(1, pctRaw);
  const R = 30;
  const C = 2 * Math.PI * R;
  const hit = def.target > 0 && def.actual >= def.target;
  const fmt = def.display === "zar" ? zarCompact : (n: number) => String(Math.round(n));

  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "relative size-[76px] cursor-default",
              hit && "drop-shadow-[0_0_10px_rgba(52,211,153,0.4)]"
            )}
          >
            {hit && (
              <motion.span
                className="absolute -right-1 -top-1 text-sm"
                initial={reduced ? false : { scale: 0, rotate: -30 }}
                animate={{ scale: [0, 1.4, 1], rotate: 0 }}
                transition={{ delay: 1.2 + index * 0.12, duration: 0.5 }}
              >
                ✨
              </motion.span>
            )}
            <svg viewBox="0 0 76 76" className="size-full -rotate-90">
              <circle cx="38" cy="38" r={R} fill="none" stroke="var(--muted)" strokeWidth="6" />
              {def.target > 0 && (
                <motion.circle
                  cx="38"
                  cy="38"
                  r={R}
                  fill="none"
                  stroke={hit ? "var(--success)" : def.color}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  initial={reduced ? { strokeDashoffset: C * (1 - pct) } : { strokeDashoffset: C }}
                  animate={{ strokeDashoffset: C * (1 - pct) }}
                  transition={{ duration: 1, delay: 0.15 + index * 0.12, ease: [0.22, 1, 0.36, 1] }}
                />
              )}
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span
                className={cn(
                  "text-[13px] font-semibold tabular-nums",
                  hit ? "text-emerald-400" : "text-foreground"
                )}
              >
                {def.target > 0 ? `${Math.round(pctRaw * 100)}%` : "—"}
              </span>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {def.target > 0
            ? `${fmt(def.actual)} of ${fmt(def.target)} target${hit ? " — hit! 🎉" : ""}`
            : "No target set for this month"}
        </TooltipContent>
      </Tooltip>
      <span className="max-w-full truncate text-[11px] text-muted-foreground">{def.label}</span>
    </div>
  );
}

export function TargetRings({ rings }: { rings: RingDef[] }) {
  const anySet = rings.some((r) => r.target > 0);
  return (
    <div>
      <div className="grid grid-cols-4 gap-2">
        {rings.map((r, i) => (
          <Ring key={r.label} def={r} index={i} />
        ))}
      </div>
      {!anySet && (
        <Link
          href="/targets"
          className="mt-2 flex items-center justify-center gap-1.5 text-xs text-primary hover:underline"
        >
          <TargetIcon className="size-3.5" />
          Set this month&apos;s targets
        </Link>
      )}
    </div>
  );
}
