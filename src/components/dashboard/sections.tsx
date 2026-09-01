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
    ? d.toLocaleTimeString("en-ZA", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Africa/Johannesburg",
      })
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
  contact: {
    id: string;
    firstName: string;
    lastName: string | null;
    isCompany: boolean;
    company: string | null;
  } | null;
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
    /*
     * `h-full` is NOT what makes a card with `rows: 2` two rows tall, and
     * assuming it was is how the blank gaps under tall cards survived a fix.
     * `height: 100%` resolves only against a containing block with a DEFINITE
     * height; the placement box around a dashboard card has `height: auto` (the
     * grid is `items-start`), so it computed to `auto` and the panel stayed at
     * its content height inside a box that had been made 22rem tall. The height
     * a card asks for is handed to THIS element directly — see CARD_MIN_HEIGHT
     * in components/dashboard/cards/placement.ts.
     *
     * It stays because SectionCard is also used in cells that are genuinely
     * stretched, where a percentage does resolve and this is what fills them.
     */
    <section className="flex h-full min-w-0 flex-col rounded-2xl border border-border/55 bg-card/35 p-5 shadow-[0_1px_0_rgba(255,255,255,0.02)] backdrop-blur-sm">
      <div className="mb-4 flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {action && (
          <Link
            href={action.href}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
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
  const startOfToday = startOfDay(new Date());
  const overdue = Boolean(highlightOverdue && a.dueDate < startOfToday);
  const Icon = a.category === "workshop" ? Wrench : ACTIVITY_ICONS[a.type] ?? Check;
  const time = timeOf(a.dueDate);
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
    <li
      className={cn(
        "group relative grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/35",
        overdue && "bg-destructive/[0.035]",
      )}
    >
      {overdue && <span className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-destructive/70" />}

      <div className="flex items-center gap-2 pt-0.5">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg border",
            overdue
              ? "border-destructive/20 bg-destructive/10 text-destructive"
              : "border-border/60 bg-background/35 text-muted-foreground",
          )}
        >
          {overdue ? <TriangleAlert className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <span className={cn("text-xs font-semibold tabular-nums", overdue ? "text-destructive" : "text-foreground")}> 
          {time ?? "—"}
        </span>
      </div>

      <div className="min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground">{a.summary}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
          {who}
          {overdue && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-destructive">Overdue {formatDate(a.dueDate)}</span>
            </>
          )}
        </p>
      </div>

      <span className="shrink-0 pt-0.5 opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
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
  const overdue = today.filter((item) => item.dueDate < startOfDay(new Date())).length;

  return (
    <SectionCard title="Today" action={action}>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary">
          {today.length} {today.length === 1 ? "action" : "actions"}
        </span>
        {overdue > 0 && (
          <span className="rounded-full bg-destructive/10 px-2.5 py-1 font-medium text-destructive">
            {overdue} overdue
          </span>
        )}
        {today.length === 0 && <span className="text-muted-foreground">Your agenda is clear.</span>}
      </div>

      {today.length > 0 && (
        <ul className="space-y-1">
          {today.map((a) => (
            <ActivityRow key={a.id} a={a} highlightOverdue />
          ))}
        </ul>
      )}

      {tomorrow.length > 0 && (
        <div className="mt-5 border-t border-border/45 pt-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Tomorrow</p>
            <span className="text-xs tabular-nums text-muted-foreground">{tomorrow.length}</span>
          </div>
          <ul className="space-y-1 opacity-80">
            {tomorrow.map((a) => (
              <ActivityRow key={a.id} a={a} />
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
