"use client";

import {
  Area,
  Bar,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

/* Shared look for every chart — dark, quiet grid, token colors. */
const AXIS = { stroke: "transparent", tick: { fill: "var(--muted-foreground)", fontSize: 11 } };
const GRID = { stroke: "var(--border)", vertical: false } as const;

function zar(v: number) {
  if (Math.abs(v) >= 1_000_000) return `R${(v / 1_000_000).toFixed(1)}m`;
  if (Math.abs(v) >= 1_000) return `R${Math.round(v / 1_000)}k`;
  return `R${v}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function DarkTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      {label != null && <p className="mb-1 font-medium text-foreground">{label}</p>}
      {payload.map((p: any) => (
        <p key={p.dataKey ?? p.name} className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: p.color ?? p.payload?.fill }} />
          {p.name}:{" "}
          <span className="font-medium tabular-nums text-foreground">
            {p.dataKey === "wonValue" || p.unit === "R" ? zar(p.value) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function ChartCard({
  title,
  subtitle,
  children,
  right,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

/* ── Sales trend: leads (area) + won value (bars) + previous period ─── */

export type TrendPoint = {
  label: string;
  leads: number;
  won: number;
  wonValue: number; // Rands
  prevLeads: number | null;
};

export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 4, right: 0, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="leadsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="label" {...AXIS} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis yAxisId="count" {...AXIS} axisLine={false} tickLine={false} width={34} allowDecimals={false} />
        <YAxis
          yAxisId="value"
          orientation="right"
          {...AXIS}
          axisLine={false}
          tickLine={false}
          width={46}
          tickFormatter={zar}
        />
        <Tooltip content={<DarkTooltip />} cursor={{ fill: "var(--accent)", opacity: 0.35 }} />
        <Bar
          yAxisId="value"
          dataKey="wonValue"
          name="Won value"
          fill="var(--chart-1)"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
        <Area
          yAxisId="count"
          type="monotone"
          dataKey="leads"
          name="New leads"
          stroke="var(--chart-2)"
          strokeWidth={2}
          fill="url(#leadsFill)"
        />
        <Line
          yAxisId="count"
          type="monotone"
          dataKey="prevLeads"
          name="Prev period"
          stroke="var(--muted-foreground)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ── Pipeline funnel: open leads per stage, stage colors ────────────── */

export type FunnelRow = { name: string; count: number; value: number; color: string };

export function FunnelChart({ data }: { data: FunnelRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          {...AXIS}
          axisLine={false}
          tickLine={false}
          width={110}
        />
        <Tooltip content={<DarkTooltip />} cursor={{ fill: "var(--accent)", opacity: 0.35 }} />
        <Bar dataKey="count" name="Leads" radius={[0, 4, 4, 0]} maxBarSize={22}>
          {data.map((row) => (
            <Cell key={row.name} fill={row.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Sources: donut + win-rate list ─────────────────────────────────── */

export type SourceRow = { name: string; leads: number; won: number; color: string };

export function SourcesChart({ data }: { data: SourceRow[] }) {
  const total = data.reduce((s, d) => s + d.leads, 0);
  return (
    <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[180px_1fr]">
      <div className="relative mx-auto h-[170px] w-[170px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="leads"
              nameKey="name"
              innerRadius={56}
              outerRadius={80}
              paddingAngle={2}
              strokeWidth={0}
            >
              {data.map((row) => (
                <Cell key={row.name} fill={row.color} />
              ))}
            </Pie>
            <Tooltip content={<DarkTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{total}</span>
          <span className="text-[11px] text-muted-foreground">leads</span>
        </div>
      </div>
      <ul className="min-w-0 space-y-2">
        {data.map((row) => {
          const share = total ? Math.round((row.leads / total) * 100) : 0;
          const winRate = row.leads ? Math.round((row.won / row.leads) * 100) : 0;
          return (
            <li key={row.name} className="flex items-center gap-2.5 text-[13px]">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className="min-w-0 flex-1 truncate capitalize text-foreground">{row.name}</span>
              <span className="tabular-nums text-muted-foreground">{row.leads} · {share}%</span>
              <span
                className={
                  "w-14 text-right text-xs font-medium tabular-nums " +
                  (winRate >= 20 ? "text-emerald-400" : winRate > 0 ? "text-amber-300" : "text-muted-foreground/60")
                }
              >
                {winRate}% won
              </span>
            </li>
          );
        })}
        {data.length === 0 && <li className="text-xs text-muted-foreground/70">No leads in this period.</li>}
      </ul>
    </div>
  );
}

/* ── Team: won value per member ─────────────────────────────────────── */

export type TeamRow = { name: string; won: number; wonValue: number };

export function TeamChart({ data }: { data: TeamRow[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" {...AXIS} axisLine={false} tickLine={false} width={110} />
        <Tooltip content={<DarkTooltip />} cursor={{ fill: "var(--accent)", opacity: 0.35 }} />
        <Bar dataKey="wonValue" name="Won value" unit="R" fill="var(--chart-3)" radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Service: jobs completed per bucket ─────────────────────────────── */

export type ServicePoint = { label: string; services: number };

export function ServiceChart({ data }: { data: ServicePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 4, right: 0, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="svcFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="label" {...AXIS} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis {...AXIS} axisLine={false} tickLine={false} width={34} allowDecimals={false} />
        <Tooltip content={<DarkTooltip />} />
        <Area
          type="monotone"
          dataKey="services"
          name="Services completed"
          stroke="var(--chart-4)"
          strokeWidth={2}
          fill="url(#svcFill)"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
