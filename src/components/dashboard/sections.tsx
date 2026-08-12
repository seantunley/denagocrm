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

/**
 * The server-rendered dashboard building blocks.
 *
 * LIFTED VERBATIM from src/app/(app)/page.tsx, where they were page-local
 * definitions. Markup, class names and behaviour are unchanged — the move exists
 * so the card registry can compose them, not to restyle anything. These stay
 * server components (they render the client <CompleteActivityButton/> as a
 * child) to match how they were used before.
 *
 * The animated tiles — StatSparkCard, PipelineSnapshot, TargetRings — already
 * live in ./widgets.tsx and are used as-is.
 */

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
    /*
     * `h-full` is NOT what makes a card with `rows: 2` two rows tall, and
     * assuming it was is how the blank gaps under tall cards survived a fix.
     * `height: 100%` resolves only against a containing block with a DEFINITE
     * height; the placement box around a dashboard card has `height: auto` (the
     * grid is `items-start`), so it computed to `auto` and the panel stayed at
     * its content height inside a box that had been made 22rem tall. The height
     * a card asks for is handed to THIS element directly now — see
     * CARD_MIN_HEIGHT in components/dashboard/cards/placement.ts.
     *
     * It stays because SectionCard is also used in cells that are genuinely
     * stretched, where a percentage does resolve and this is what fills them.
     */
    <div className="flex h-full min-w-0 flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        {action && (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {action.label}
            <ArrowRight className="size-3" />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

export function ActivityRow({ a, highlightOverdue }: { a: DashActivity; highlightOverdue?: boolean }) {
  const startOfToday = startOfDay(new Date());
  const overdue = highlightOverdue && a.dueDate < startOfToday;
  const Icon = a.category === "workshop" ? Wrench : ACTIVITY_ICONS[a.type] ?? Check;
  const who = a.lead ? (
    <Link href={`/leads/${a.lead.id}`} className="text-primary hover:underline">
      {a.lead.name}
    </Link>
  ) : a.contact ? (
    <Link href={`/contacts/${a.contact.id}`} className="text-primary hover:underline">
      {contactName(a.contact)}
    </Link>
  ) : null;
  return (
    <li className="group flex items-center gap-2.5 py-1.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md",
          overdue ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
        )}
      >
        {overdue ? <TriangleAlert className="size-3.5" /> : <Icon className="size-3.5" />}
      </span>
      <p className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {timeOf(a.dueDate) && (
          <span className="font-semibold tabular-nums text-primary">{timeOf(a.dueDate)} </span>
        )}
        {a.summary}
        <span className="text-[11px] text-muted-foreground">
          {" — "}
          {who ?? "general"} · {a.assignedTo.name.split(" ")[0]}
          {overdue && <span className="text-destructive"> · {formatDate(a.dueDate)}</span>}
        </span>
      </p>
      <span className="shrink-0">
        <CompleteActivityButton activityId={a.id} />
      </span>
    </li>
  );
}

/** Today + tomorrow merged into one card with day dividers — no empty panels. */
export function AgendaCard({
  today,
  tomorrow,
  action,
}: {
  today: DashActivity[];
  tomorrow: DashActivity[];
  action?: { href: string; label: string };
}) {
  const DayLabel = ({ children }: { children: React.ReactNode }) => (
    <p className="pb-0.5 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/60 first:pt-0">
      {children}
    </p>
  );
  return (
    <SectionCard title="Agenda" action={action}>
      <DayLabel>Today</DayLabel>
      {today.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/60">Nothing due today.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {today.map((a) => (
            <ActivityRow key={a.id} a={a} highlightOverdue />
          ))}
        </ul>
      )}
      <DayLabel>Tomorrow</DayLabel>
      {tomorrow.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground/60">Nothing planned yet.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {tomorrow.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
