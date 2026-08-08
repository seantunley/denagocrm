import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  CarFront,
  CircleDollarSign,
  ClipboardList,
  Clock4,
  FileSignature,
  FileText,
  Inbox,
  Link2,
  Mail,
  Phone,
  Plus,
  Search,
  Settings2,
  SquareKanban,
  Truck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { normaliseHref, type ButtonCard } from "@/lib/dashboard/config";
import type { RenderContext, RenderedCard } from "./shell";

/**
 * A link tile — the shortcut someone puts on their own dashboard.
 *
 * ── THE HREF IS CHECKED HERE TOO ────────────────────────────────────────────
 *
 * `normaliseHref` refuses anything that is not a path inside this app, and it
 * runs on the way in as well. It runs again here because a config row can
 * predate the check: a dashboard saved before the rule existed, or one written
 * straight into the database, would otherwise put an off-site link inside the
 * product's own chrome — a button on the company dashboard is trusted the way an
 * email link never is, which is exactly what makes it worth phishing.
 *
 * A refused href renders NOTHING rather than a dead tile. There is no useful
 * "this link was rejected" state for a reader who did not write it, and a
 * disabled-looking button invites someone to go and re-save the bad value.
 *
 * ── WHY THE ICONS ARE AN ALLOWLIST ──────────────────────────────────────────
 *
 * `icon` is a name out of a saved config. Resolving a name to a component at
 * runtime means importing the whole of lucide — some 1,500 components — into the
 * first page every user loads, and it means an unknown name is a crash rather
 * than a missing icon. A written-out map is a few dozen bytes and cannot fail:
 * anything not in it falls back to the arrow, which is what a link tile means
 * anyway. This mirrors how the rest of the app does it — see ACTIVITY_ICONS in
 * components/dashboard/sections.tsx.
 */
const BUTTON_ICONS: Record<string, LucideIcon> = {
  activity: ClipboardList,
  calendar: CalendarDays,
  clock: Clock4,
  contacts: Users,
  deliveries: Truck,
  document: FileText,
  inbox: Inbox,
  jobcard: Wrench,
  leads: SquareKanban,
  link: Link2,
  mail: Mail,
  money: CircleDollarSign,
  phone: Phone,
  plus: Plus,
  quotes: FileText,
  search: Search,
  settings: Settings2,
  signature: FileSignature,
  vehicles: CarFront,
};

export function renderButton(card: ButtonCard, _ctx: RenderContext): RenderedCard {
  const href = normaliseHref(card.href);
  if (!href) return { node: null, signals: {} };

  const Icon = (card.icon && BUTTON_ICONS[card.icon]) || ArrowRight;

  return {
    node: (
      <Link
        href={href}
        className="group flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-4" />
        </span>
        {/* The href is the fallback label. A button with no title is a
            configuration someone is halfway through, and showing where it goes
            is more use than showing an empty tile. */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {card.title ?? href}
        </span>
        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </Link>
    ),
    signals: {},
  };
}
