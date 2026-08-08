"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CalendarDays,
  FileStack,
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
  "/marketing/templates": FileStack,
};

export default function MarketingWorkspaceShell({
  children,
  sections,
}: {
  children: ReactNode;
  sections: MarketingWorkspaceSection[];
}) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-2xl border border-fuchsia-400/15 bg-gradient-to-br from-fuchsia-500/[0.12] via-card to-card shadow-sm">
        <div className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-fuchsia-400/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 px-5 pb-0 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-300 shadow-sm"><Megaphone className="size-5" /></span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Growth &amp; engagement</p>
              <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.04em] text-foreground sm:text-[28px]">Marketing</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Plan audiences, govern campaigns, measure commercial impact and close the customer feedback loop.</p>
            </div>
          </div>
          <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="Marketing workspace">
            {sections.map(({ href, label }) => {
              const Icon = sectionIcons[href] ?? Megaphone;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active(href) ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-xs font-semibold transition-colors",
                    active(href) ? "border-fuchsia-300 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
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
