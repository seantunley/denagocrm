"use client";

import { Landmark } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A financed deal's finance, as the lead board shows it — worked out on the server (dealFinance.financeOnBoard). */
export type KanbanFinance = {
  house: string;
  /** "Q-1045" — which of the deal's quotes this finance is for (finance is per quote). */
  quote: string | null;
  /** Short status: "Submitted", "Approved"… */
  status: string;
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  /** What to chase when it has stalled (3 working days), else null. */
  chase: string | null;
};

const TONE: Record<KanbanFinance["tone"], string> = {
  success: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  danger: "bg-rose-500/10 text-rose-300 ring-rose-500/20",
  info: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  neutral: "bg-muted text-muted-foreground ring-border",
};

/**
 * The finance pill on a lead card (Sean, 2026-11-16: "put the finance status on the kanban lead if it is present").
 * Nothing on a cash deal. A stalled one says what to chase on hover.
 */
export default function KanbanFinancePill({ finance }: { finance?: KanbanFinance | null }) {
  if (!finance) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ring-1", TONE[finance.chase ? "warning" : finance.tone])}>
          <Landmark className="size-3" />
          {finance.status}
        </span>
      </TooltipTrigger>
      <TooltipContent>{finance.chase ?? `Finance${finance.quote ? ` on ${finance.quote}` : ""} with ${finance.house}: ${finance.status.toLowerCase()}`}</TooltipContent>
    </Tooltip>
  );
}
