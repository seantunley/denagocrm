"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  BellRing,
  BookOpenText,
  Boxes,
  Building2,
  Cable,
  ChevronRight,
  Database,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import SettingsNav from "@/components/SettingsNav";
import { PageHeader } from "@/components/page-header";
import { Surface } from "@/components/visual-system";
import { settingsDestination, type SettingsGroup } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";

const groupIcons: Record<string, LucideIcon> = {
  Workspace: Settings2,
  Personal: UserRound,
  "Sales & CRM": SlidersHorizontal,
  Operations: Wrench,
  Communications: BellRing,
  Organisation: Building2,
  "Security & Access": ShieldCheck,
  "Documents & Data": Database,
  System: Boxes,
};

/**
 * When true, SettingsWorkspace renders only the active section (title + content)
 * and drops the full-page chrome — the settings search bar and the all-categories
 * nav column. The settings-as-a-modal intercept turns this on so the popup shows
 * just the section you clicked, not the whole settings page.
 */
const SettingsChromeless = createContext(false);

export function SettingsChromelessProvider({ children }: { children: ReactNode }) {
  return <SettingsChromeless.Provider value={true}>{children}</SettingsChromeless.Provider>;
}

export function SettingsWorkspace({
  current,
  title,
  description,
  actions,
  groups,
  children,
}: {
  current: string;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  groups: SettingsGroup[];
  children: ReactNode;
}) {
  const chromeless = useContext(SettingsChromeless);

  if (chromeless) {
    return (
      <div className="space-y-4">
        <PageHeader title={title} description={description}>{actions}</PageHeader>
        <main className="min-w-0 space-y-4">{children}</main>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={title} description={description}>{actions}</PageHeader>
      <SettingsFinder groups={groups} />
      <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav groups={groups} current={current} />
        <main className="min-w-0 space-y-4">{children}</main>
      </div>
    </div>
  );
}

function SettingsFinder({ groups }: { groups: SettingsGroup[] }) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return groups.flatMap((group) => group.items
      .filter((item) => [item.label, ...(item.keywords ?? []), group.label].join(" ").toLowerCase().includes(needle))
      .map((item) => ({ ...item, group: group.label }))
    ).slice(0, 8);
  }, [groups, query]);

  return (
    <div className="relative max-w-2xl">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="input pl-9 pr-24"
        placeholder="Find a setting, integration or policy…"
        aria-label="Search settings"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Settings</span>
      {query.trim() && (
        <Surface className="absolute inset-x-0 top-[calc(100%+.5rem)] z-30 overflow-hidden bg-popover shadow-2xl">
          {matches.length ? (
            <ul className="divide-y divide-border">
              {matches.map((item) => (
                <li key={item.key}>
                  <Link href={settingsDestination(item)} onClick={() => setQuery("")} className="flex items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-accent/60">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/40 text-muted-foreground"><Settings2 className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{item.label}</span><span className="block text-xs text-muted-foreground">{item.group}</span></span>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No setting matches “{query.trim()}”.</div>
          )}
        </Surface>
      )}
    </div>
  );
}

export function SettingsOverview({ groups }: { groups: SettingsGroup[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {groups.filter((group) => group.label !== "Workspace").map((group) => {
        const Icon = groupIcons[group.label] ?? Cable;
        return (
          <Surface key={group.label} className="p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><Icon className="size-4" /></span>
              <div><h2 className="font-semibold tracking-tight text-foreground">{group.label}</h2><p className="text-xs text-muted-foreground">{group.items.length} configuration area{group.items.length === 1 ? "" : "s"}</p></div>
            </div>
            <div className="mt-3 divide-y divide-border border-t border-border">
              {group.items.map((item) => (
                <Link key={item.key} href={settingsDestination(item)} className="flex items-center justify-between gap-3 py-2.5 text-sm text-muted-foreground transition hover:text-foreground">
                  {item.label}<ChevronRight className="size-4 shrink-0" />
                </Link>
              ))}
            </div>
          </Surface>
        );
      })}
    </div>
  );
}

export function SettingsSection({
  icon: Icon = BookOpenText,
  title,
  description,
  action,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-sm", className)}>
      <header className="flex flex-col gap-2.5 border-b border-border bg-muted/20 p-3.5 sm:flex-row sm:items-start sm:justify-between sm:p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary"><Icon className="size-4" /></span>
          <div><h2 className="font-semibold tracking-tight text-foreground">{title}</h2>{description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>}</div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="p-3.5 sm:p-4">{children}</div>
    </section>
  );
}

export function SettingsIntegrationRow({
  title,
  status,
  action = "Configure",
  children,
}: {
  title: string;
  status?: ReactNode;
  action?: string;
  children: ReactNode;
}) {
  return (
    <details className="group border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 transition hover:bg-muted/20 [&::-webkit-details-marker]:hidden sm:px-4">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">{title}{status}</span>
        <span className="btn-secondary btn-sm shrink-0">{action}</span>
      </summary>
      <div className="border-t border-border bg-background/20 px-3.5 py-4 sm:px-4">{children}</div>
    </details>
  );
}
