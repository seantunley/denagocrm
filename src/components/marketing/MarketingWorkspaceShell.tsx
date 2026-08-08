"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CalendarDays,
  FileStack,
  Gift,
  HeartPulse,
  Megaphone,
  MessagesSquare,
  Target,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MarketingWorkspaceSection } from "@/components/marketing/marketing-workspace-nav";

const sectionIcons: Record<string, LucideIcon> = {
  "/marketing/overview": BarChart3,
  "/marketing/campaigns": Megaphone,
  "/marketing/audiences": Target,
  "/marketing/calendar": CalendarDays,
  "/marketing/surveys": MessagesSquare,
  "/marketing/surveys/insights": HeartPulse,
  "/marketing/templates": FileStack,
  "/referrals": Gift,
};

export default function MarketingWorkspaceShell({
  children,
  sections,
}: {
  children: ReactNode;
  sections: MarketingWorkspaceSection[];
}) {
  const pathname = usePathname();
  const activeHref = sections
    .filter(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-fuchsia-400/15 bg-gradient-to-br from-fuchsia-500/[0.12] via-card to-card shadow-sm">
        <div className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-fuchsia-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 px-5 pb-0 pt-5 sm:gap-3 sm:px-5 sm:pt-4">
          <div className="flex items-start gap-4 sm:items-center sm:gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300 shadow-sm sm:size-9 sm:rounded-xl"><Megaphone className="size-5 sm:size-4" /></span>
            <div className="min-w-0 sm:flex sm:flex-1 sm:items-center sm:gap-4">
              <div className="shrink-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Growth &amp; engagement</p>
                <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.04em] text-foreground sm:mt-0.5 sm:text-xl">Marketing</h1>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:mt-0 sm:max-w-none sm:text-xs sm:leading-5">Plan audiences, govern campaigns, measure commercial impact and close the customer feedback loop.</p>
            </div>
          </div>
          <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="Marketing workspace">
            {sections.map(({ href, label }) => {
              const Icon = sectionIcons[href] ?? Megaphone;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={activeHref === href ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-xs font-semibold transition-colors sm:py-2.5",
                    activeHref === href ? "border-fuchsia-300 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />{label}
                </Link>
              );
            })}
          </nav>
        </div>
      </section>
      {children}
    </div>
  );
}
