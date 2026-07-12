import Link from "next/link";
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
  Bot,
  DatabaseBackup,
} from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { getLastRun, getHistory, type CheckResult } from "@/lib/securityRunbook";
import { getAiHealth, getAiUsageThisMonth } from "@/lib/systemHealth";
import { runSecurityNow } from "@/app/actions/runbook";
import { RunButton } from "./RunButton";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
// The runbook makes several live self-probes; give it headroom over Vercel's
// short default so the sweep can finish and revalidate the page.
export const maxDuration = 60;

const STATUS = {
  pass: { icon: ShieldCheck, cls: "text-emerald-400", chip: "bg-emerald-500/10 text-emerald-300" },
  warn: { icon: ShieldAlert, cls: "text-amber-400", chip: "bg-amber-500/10 text-amber-300" },
  fail: { icon: ShieldX, cls: "text-red-400", chip: "bg-red-500/10 text-red-300" },
} as const;

function ResultRow({ r }: { r: CheckResult }) {
  const S = STATUS[r.status];
  return (
    <li className="flex items-start gap-3 py-2.5">
      <S.icon className={cn("mt-0.5 size-4 shrink-0", S.cls)} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{r.label}</p>
        <p className="text-xs text-muted-foreground">{r.detail}</p>
        {r.fix && r.status !== "pass" && (
          <p className="mt-0.5 text-xs text-amber-300/90">Fix: {r.fix}</p>
        )}
      </div>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", S.chip)}>
        {r.status}
      </span>
    </li>
  );
}

export default async function SecurityPage() {
  await requireOwner();
  const [run, history, ai, usage] = await Promise.all([
    getLastRun(),
    getHistory(),
    getAiHealth(),
    getAiUsageThisMonth(),
  ]);

  const groups = run
    ? [...new Set(run.results.map((r) => r.group))].map((g) => ({
        name: g,
        results: run.results.filter((r) => r.group === g),
      }))
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/settings"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Settings
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Security runbook</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Automated checks on keys, exposure, backups and accounts. Runs monthly by itself —
            or on demand. Alerts go to the people who ticked “Security” in their notifications.
          </p>
        </div>
        <form action={runSecurityNow}>
          <RunButton />
        </form>
      </div>

      {/* Score + system health strip */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Score</p>
          <p
            className={cn(
              "mt-1 text-2xl font-semibold tabular-nums",
              !run ? "text-muted-foreground" : run.failed ? "text-red-400" : run.warned ? "text-amber-300" : "text-emerald-400"
            )}
          >
            {run ? `${run.score}%` : "—"}
          </p>
          <p className="text-xs text-muted-foreground">
            {run
              ? `${run.passed} passed · ${run.warned} warn · ${run.failed} failed`
              : "Never run — hit the button."}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Last run</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {run ? new Date(run.ranAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "—"}
          </p>
          <p className="text-xs text-muted-foreground">Auto-runs on the 1st of every month.</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <Bot className="size-3.5" />
            AI health
          </p>
          <p
            className={cn(
              "mt-1 text-2xl font-semibold",
              !ai || ai.status === "unconfigured"
                ? "text-muted-foreground"
                : ai.status === "ok"
                  ? "text-emerald-400"
                  : "text-red-400"
            )}
          >
            {!ai ? "—" : ai.status === "ok" ? "OK" : ai.status === "unconfigured" ? "Off" : "DOWN"}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={ai?.detail}>
            {ai?.detail ?? "Checked hourly once AI is configured."}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            <DatabaseBackup className="size-3.5" />
            AI usage (month)
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {usage.calls}
            <span className="text-sm font-normal text-muted-foreground"> calls</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {(usage.in / 1000).toFixed(1)}k in · {(usage.out / 1000).toFixed(1)}k out tokens
          </p>
        </div>
      </div>

      {/* Results */}
      {run ? (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {groups.map((g) => (
            <div key={g.name} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.name}
              </p>
              <ul className="divide-y divide-border/50">
                {g.results.map((r) => (
                  <ResultRow key={r.id} r={r} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Run the checks to see your security posture.
        </div>
      )}

      {/* History */}
      {history.length > 1 && (
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            History (accountability trail)
          </p>
          <ul className="divide-y divide-border/50 text-[13px]">
            {history.map((h) => (
              <li key={h.ranAt} className="flex items-center gap-3 py-1.5">
                <span className="tabular-nums text-muted-foreground">
                  {new Date(h.ranAt).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="font-medium tabular-nums text-foreground">{h.score}%</span>
                <span className="text-xs text-muted-foreground">
                  {h.failed} failed · {h.warned} warnings
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
