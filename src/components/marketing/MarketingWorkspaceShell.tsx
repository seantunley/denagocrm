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
import { WorkspaceHero } from "@/components/workspace-hero";
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
      <WorkspaceHero
        icon={Megaphone}
        eyebrow="Growth & engagement"
        title="Marketing"
        description="Plan audiences, govern campaigns, measure commercial impact and close the customer feedback loop."
        tone="marketing"
        navigation={
          <nav className="flex max-w-full gap-1 overflow-x-auto" aria-label="Marketing workspace">
            {sections.map(({ href, label }) => {
              const Icon = sectionIcons[href] ?? Megaphone;
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={activeHref === href ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                    activeHref === href ? "border-fuchsia-300 text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />{label}
                </Link>
              );
            })}
          </nav>
        }
      />
      {children}
    </div>
  );
}
