import Link from "next/link";
import { CalendarDays, FileText, UserRound } from "lucide-react";
import { TabLink } from "@/components/Tabs";
import { formatDateTime, formatZAR } from "@/lib/format";
import type { ReactNode } from "react";

/** The same supporting column as contacts, with the current deal's context. */
export default function LeadWorkspaceContext({ nextActivity, canSchedule, customer, product, color, quantity, valueCents, stage, owner, latestQuote, secureLinks }: {
  nextActivity: { summary: string; dueDate: Date; note?: string | null; assignedTo?: { name: string } | null } | null;
  canSchedule: boolean;
  customer: { name: string; href?: string };
  product?: string | null; color?: string | null; quantity: number; valueCents: number | null;
  stage: string; owner?: string | null;
  latestQuote?: { number: number; status: string; totalCents: number } | null;
  secureLinks: ReactNode;
}) {
  const overdue = nextActivity && nextActivity.dueDate < new Date();
  return <>
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><CalendarDays className="size-4 text-muted-foreground" />Next action</h2>
      {nextActivity ? <>
        <p className="break-words text-sm font-medium">{nextActivity.summary}</p>
        <p className={`mt-1 text-xs ${overdue ? "text-amber-400" : "text-muted-foreground"}`}>{overdue ? "Overdue · " : ""}{formatDateTime(nextActivity.dueDate)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{nextActivity.assignedTo?.name ?? "Unassigned"}</p>
        {nextActivity.note && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{nextActivity.note}</p>}
      </> : <p className="text-sm text-muted-foreground">No follow-up scheduled.</p>}
      {(nextActivity || canSchedule) && <TabLink tab="activities" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">{nextActivity ? "Manage activities" : "Schedule an activity"}</TabLink>}
    </section>
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">Deal at a glance</h2>
      <p className="text-lg font-semibold tabular-nums">{/* 0 is how an unset value is stored: "R 0,00" beside a R 249 900 quote misreads the deal. */}{valueCents ? formatZAR(valueCents) : "Value not set"}</p>
      <p className="mt-1 break-words text-sm">{product || "Product not selected"}{color ? ` · ${color}` : ""}{quantity > 1 ? ` · ${quantity} units` : ""}</p>
      <dl className="mt-4 space-y-2 text-xs">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Stage</dt><dd className="text-right">{stage}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Owner</dt><dd className="text-right">{owner || "Unassigned"}</dd></div>
      </dl>
      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"><UserRound className="size-3.5" />Customer</p>
        {customer.href ? <Link href={customer.href} className="break-words text-sm font-medium hover:text-primary">{customer.name}</Link> : <p className="break-words text-sm">{customer.name}</p>}
      </div>
      {latestQuote && <div className="mt-4 border-t border-border pt-3"><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileText className="size-3.5" />Latest quote</p><TabLink tab="quotes" className="mt-1 block text-left text-sm hover:text-primary">Q-{latestQuote.number} · {latestQuote.status}</TabLink><p className="mt-1 text-xs text-muted-foreground">{formatZAR(latestQuote.totalCents)}</p></div>}
      <TabLink tab="details" className="mt-3 inline-flex text-xs font-medium text-primary hover:underline">View deal details</TabLink>
    </section>
    <details className="rounded-xl border border-border bg-card p-4"><summary className="cursor-pointer text-sm font-medium">Secure links</summary><div className="mt-3">{secureLinks}</div></details>
  </>;
}
