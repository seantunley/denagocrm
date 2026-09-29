"use client";

import { AlertTriangle, CheckCircle2, CircleX } from "lucide-react";
import type { FlowChannel, FlowIssue } from "@/lib/flowValidation";

const channelLabel: Record<FlowChannel, string> = {
  whatsapp: "WhatsApp",
  messenger: "Messenger",
  instagram: "Instagram",
  telegram: "Telegram",
};

export default function FlowLintPanel({
  issues,
  channels,
  onSelectIssue,
  live = false,
}: {
  issues: FlowIssue[];
  channels: FlowChannel[];
  onSelectIssue?: (issue: FlowIssue) => void;
  live?: boolean;
}) {
  const errors = issues.filter((item) => item.severity === "error");
  const warnings = issues.filter((item) => item.severity === "warning");

  if (!issues.length) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-200">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>{live ? "Current canvas is ready" : "Ready to publish"} for {channels.map((channel) => channelLabel[channel]).join(", ")}.</span>
      </div>
    );
  }

  return (
    <details className="rounded-xl border border-white/10 bg-white/[0.025]" open={errors.length > 0}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        {errors.length ? <CircleX className="size-4 text-red-400" /> : <AlertTriangle className="size-4 text-amber-400" />}
        <span className="text-sm font-medium text-white">
          {errors.length ? `${errors.length} publish error${errors.length === 1 ? "" : "s"}` : "Flow checks passed with warnings"}
        </span>
        {warnings.length > 0 && <span className="text-xs text-slate-400">· {warnings.length} warning{warnings.length === 1 ? "" : "s"}</span>}
        <span className="ml-auto text-xs text-slate-500">{channels.map((channel) => channelLabel[channel]).join(" · ")}</span>
      </summary>
      <div className="border-t border-white/8 px-4 py-3">
        <ul className="space-y-2">
          {issues.map((item, index) => (
            <li key={`${item.code}-${item.nodeId ?? "flow"}-${item.channel ?? "all"}-${index}`}>
              <button type="button" disabled={!item.nodeId || !onSelectIssue} onClick={() => onSelectIssue?.(item)} className="flex w-full gap-2 rounded-lg px-2 py-1 text-left text-xs leading-5 text-slate-300 enabled:hover:bg-white/5 disabled:cursor-default">
              <span className={item.severity === "error" ? "text-red-400" : "text-amber-400"}>{item.severity === "error" ? "Error" : "Warning"}</span>
              <span>
                {item.message}
                {item.nodeId ? <span className="text-slate-500"> · node {item.nodeId}</span> : null}
                {item.channel ? <span className="text-slate-500"> · {channelLabel[item.channel]}</span> : null}
              </span>
              {item.nodeId && onSelectIssue ? <span className="ml-auto shrink-0 text-[10px] text-orange-300">Show node →</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
