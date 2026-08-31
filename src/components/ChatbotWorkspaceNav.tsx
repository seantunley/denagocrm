"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  Bot,
  BookOpen,
  ChevronDown,
  FlaskConical,
  GitBranch,
  Inbox,
  Route,
  X,
  type LucideIcon,
} from "lucide-react";

type WorkspaceItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
};

type WorkspaceGroup = {
  label: "Configure" | "Test" | "Operate";
  items: WorkspaceItem[];
};

const workspaceGroups: WorkspaceGroup[] = [
  {
    label: "Configure",
    items: [
      { label: "Overview", href: "/chatbot", icon: Bot, exact: true },
      { label: "Flows", href: "/bot-builder", icon: GitBranch },
      { label: "Routing", href: "/bot-builder/routes", icon: Route },
      { label: "Knowledge", href: "/chatbot/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Test",
    items: [
      { label: "Answer preview", href: "/chatbot/preview", icon: FlaskConical },
    ],
  },
  {
    label: "Operate",
    items: [
      { label: "Handoffs", href: "/inbox", icon: Inbox },
      { label: "Analytics", href: "/bot-analytics", icon: BarChart3 },
    ],
  },
];

const workspaceItems = workspaceGroups.flatMap((group) => group.items);

function isItemActive(pathname: string, item: WorkspaceItem) {
  if (item.exact) return pathname === item.href;
  const path = item.href.split("?")[0];
  if (path === "/bot-builder" && pathname.startsWith("/bot-builder/routes")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function WorkspaceLink({ item, pathname, onNavigate }: { item: WorkspaceItem; pathname: string; onNavigate?: () => void }) {
  const active = isItemActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors md:min-h-8 md:px-2.5 md:text-[13px] ${
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/55 hover:text-foreground"
      }`}
    >
      <Icon className={`size-4 shrink-0 transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

function DesktopGroup({ group, pathname, separated }: { group: WorkspaceGroup; pathname: string; separated?: boolean }) {
  return (
    <div
      className={`flex shrink-0 flex-col gap-1 ${separated ? "border-l border-border/60 pl-4" : ""}`}
      aria-label={`${group.label} Flowbot tools`}
    >
      <span className="px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/55">
        {group.label}
      </span>
      <div className="flex items-center gap-1">
        {group.items.map((item) => <WorkspaceLink key={item.href} item={item} pathname={pathname} />)}
      </div>
    </div>
  );
}

export default function ChatbotWorkspaceNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isFlowWorkspace = pathname.startsWith("/bot-builder/") && !pathname.startsWith("/bot-builder/routes");

  if (isFlowWorkspace) return null;

  const activeItem = workspaceItems.find((item) => isItemActive(pathname, item));

  return (
    <header className="mb-3 border-b border-border/70 pb-2" aria-label="Flowbot workspace navigation">
      <div className="flex min-h-11 items-center gap-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/8 text-primary">
            <Bot className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-semibold leading-none">Flowbot</p>
              <span className="hidden text-[11px] text-muted-foreground xl:inline">Customer automation</span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground md:hidden">{activeItem?.label ?? "Workspace"}</p>
          </div>
        </div>

        <nav className="hidden min-w-0 flex-1 items-end gap-4 overflow-x-auto border-l border-border/60 pl-4 md:flex [scrollbar-width:thin]" aria-label="Flowbot sections">
          {workspaceGroups.map((group, index) => (
            <DesktopGroup key={group.label} group={group} pathname={pathname} separated={index > 0} />
          ))}
        </nav>

        <button
          type="button"
          className="btn-secondary ml-auto min-h-11 min-w-11 p-0 md:hidden"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? "Close Flowbot navigation" : "Open Flowbot navigation"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </button>
      </div>

      {mobileOpen ? (
        <nav className="grid gap-3 pt-2 md:hidden" aria-label="Flowbot sections">
          {workspaceGroups.map((group) => (
            <div key={group.label} className="grid gap-1">
              <span className="px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/55">{group.label}</span>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {group.items.map((item) => (
                  <WorkspaceLink key={item.href} item={item} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
                ))}
              </div>
            </div>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
