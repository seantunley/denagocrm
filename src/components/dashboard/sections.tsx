import Link from "next/link";
import { startOfDay } from "date-fns";
import {
  Wrench,
  Phone,
  Mail,
  MessageCircle,
  Car,
  Users,
  Repeat,
  Check,
  TriangleAlert,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { CompleteActivityButton } from "@/components/proactive/NextStep";
import { formatDate, contactName } from "@/lib/format";
import { cn } from "@/lib/utils";

const timeOf = (d: Date) =>
  d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0
    ? d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })
    : null;

const ACTIVITY_ICONS: Record<string, LucideIcon> = {
  call: Phone,
  email: Mail,
  whatsapp: MessageCircle,
  meeting: Users,
  test_drive: Car,
  follow_up: Repeat,
};

export type DashActivity = {
  id: string;
  type: string;
  category: string | null;
  summary: string;
  dueDate: Date;
  assignedTo: { name: string };
  lead: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string | null; isCompany: boolean; company: string | null } | null;
};

export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="flex h-full min-w-0 flex-col rounded-2xl bg-muted/[0.16] p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {action && (
          <Link
            href={action.href}
            className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {action.label}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function ActivityRow({ a, highlightOverdue }: { a: DashActivity; highlightOverdue?: boolean }) {
  const overdue = Boolean(highlightOverdue && a.dueDate < startOfDay(new Date()));
  const Icon = a.category === "workshop" ? Wrench : ACTIVITY_ICONS[a.type] ?? Check;
  const who = a.lead ? (
    <Link href={`/leads/${a.lead.id}`} className="font-medium text-foreground hover:underline">
      {a.lead.name}
    </Link>
  ) : a.contact ? (
    <Link href={`/contacts/${a.contact.id}`} className="font-medium text-foreground hover:underline">
      {contactName(a.contact)}
    </Link>
  ) : (
    <span>General</span>
  );

  return (
    <li className="group grid grid-cols-[3.75rem_minmax(0,1fr)_auto] items-start gap-3 py-3">
      <div className="flex items-center gap-2 pt-0.5">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg",
            overdue ? "bg-destructive/10 text-destructive" : "bg-background/55 text-muted-foreground",
          )}
        >
          {overdue ? <TriangleAlert className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <span className={cn("text-xs font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}>
          {timeOf(a.dueDate) ?? "—"}
        </span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground">{a.summary}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {who}
          {overdue && <span className="text-destructive"> · overdue {formatDate(a.dueDate)}</span>}
        </p>
      </div>
      <span className="shrink-0 pt-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <CompleteActivityButton activityId={a.id} />
      </span>
    </li>
  );
}

export function AgendaCard({
  today,
  tomorrow,
  action,
}: {
  today: DashActivity[];
  tomorrow: DashActivity[];
  action?: { href: string; label: string };
}) {
  return (
    <SectionCard title="Agenda" action={action}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-foreground">Today</span>
        <span className="rounded-full bg-background/60 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
          {today.length}
        </span>
      </div>
      {today.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">Nothing due today.</p>
      ) : (
        <ul className="divide-y divide-border/35">
          {today.map((a) => (
            <ActivityRow key={a.id} a={a} highlightOverdue />
          ))}
        </ul>
      )}

      {tomorrow.length > 0 && (
        <div className="mt-5 border-t border-border/35 pt-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Tomorrow</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{tomorrow.length}</span>
          </div>
          <ul className="divide-y divide-border/25 opacity-80">
            {tomorrow.map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
