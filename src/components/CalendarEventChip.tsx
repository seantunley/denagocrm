"use client";

import Link from "next/link";
import {
  Phone,
  Mail,
  MessageCircle,
  Users,
  Car,
  Wrench,
  CheckSquare,
  Check,
  MapPin,
  User,
  StickyNote,
  Clock4,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CalendarEvent = {
  id: string;
  href: string;
  summary: string;
  time: string | null; // "14:30" or null for all-day
  status: string; // planned | done | canceled
  overdue: boolean; // planned and in the past
  type: string;
  workshop: boolean;
  who: string | null; // lead/contact display name
  phone: string | null;
  email: string | null;
  assignee: string;
  location: string | null;
  note: string | null;
  dateLabel: string; // "Thu 10 Jul"
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  call: Phone,
  email: Mail,
  whatsapp: MessageCircle,
  meeting: Users,
  test_drive: Car,
  todo: CheckSquare,
};

export default function CalendarEventChip({ event }: { event: CalendarEvent }) {
  const Icon = event.workshop ? Wrench : TYPE_ICONS[event.type] ?? CheckSquare;
  const done = event.status === "done";

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Link
          href={event.href}
          className={cn(
            "flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] leading-4 transition-[filter] hover:brightness-125",
            done
              ? "bg-muted/70 text-muted-foreground"
              : event.overdue
                ? "bg-red-500/15 text-red-300"
                : event.workshop
                  ? "bg-emerald-500/15 text-emerald-200"
                  : event.type === "meeting" || event.type === "test_drive"
                    ? "bg-primary/15 text-orange-200"
                    : "bg-muted text-foreground/80"
          )}
        >
          {done ? <Check className="size-3 shrink-0" /> : <Icon className="size-3 shrink-0" />}
          <span className={cn("truncate", done && "line-through decoration-muted-foreground/50")}>
            {event.time ? `${event.time} ` : ""}
            {event.summary}
          </span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 p-0">
        <div className="space-y-2 p-3">
          <div>
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-popover-foreground">
              <Icon className="size-3.5 text-primary" />
              {event.summary}
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock4 className="size-3" />
              {event.dateLabel}
              {event.time ? ` · ${event.time}` : ""}
              <span
                className={cn(
                  "ml-1 rounded-full px-1.5 py-px text-[10px] font-medium",
                  done
                    ? "bg-emerald-500/15 text-emerald-300"
                    : event.overdue
                      ? "bg-red-500/15 text-red-300"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {done ? "completed" : event.overdue ? "overdue" : "planned"}
              </span>
            </p>
          </div>

          <div className="space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
            {event.who && (
              <p className="flex items-center gap-1.5">
                <User className="size-3 shrink-0" />
                <span className="truncate text-popover-foreground">{event.who}</span>
              </p>
            )}
            {event.phone && (
              <p className="flex items-center gap-1.5">
                <Phone className="size-3 shrink-0" />
                {event.phone}
              </p>
            )}
            {event.email && (
              <p className="flex items-center gap-1.5 truncate">
                <Mail className="size-3 shrink-0" />
                <span className="truncate">{event.email}</span>
              </p>
            )}
            {event.location && (
              <p className="flex items-center gap-1.5">
                <MapPin className="size-3 shrink-0" />
                {event.location}
              </p>
            )}
            {event.note && (
              <p className="flex items-start gap-1.5">
                <StickyNote className="mt-0.5 size-3 shrink-0" />
                <span className="line-clamp-2">{event.note}</span>
              </p>
            )}
            <p className="flex items-center gap-1.5 pt-0.5">
              <span className="flex size-3.5 items-center justify-center rounded-full bg-primary/15 text-[8px] font-bold text-primary">
                {event.assignee
                  .split(/\s+/)
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </span>
              Assigned to {event.assignee}
            </p>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
