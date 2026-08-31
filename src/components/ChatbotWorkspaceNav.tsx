"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Bot, ChevronDown, X } from "lucide-react";

type WorkspaceItem = {
  label: string;
  href: string;
  exact?: boolean;
};

const workspaceItems: WorkspaceItem[] = [
  { label: "Overview", href: "/chatbot", exact: true },
  { label: "Flows", href: "/bot-builder" },
  { label: "Routing", href: "/bot-builder/routes" },
  { label: "Knowledge", href: "/chatbot/knowledge" },
  { label: "Answer preview", href: "/chatbot/preview" },
  { label: "Handoffs", href: "/inbox" },
  { label: "Analytics", href: "/bot-analytics" },
];

function isItemActive(pathname: string, item: WorkspaceItem) {
  if (item.exact) return pathname === item.href;
  const path = item.href.split("?")[0];
  if (path === "/bot-builder" && pathname.startsWith("/bot-builder/routes")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function WorkspaceLink({ item, pathname, onNavigate }: { item: WorkspaceItem; pathname: string; onNavigate?: () => void }) {
  const active = isItemActive(pathname, item);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium transition md:min-h-9 ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {item.label}
    </Link>
  );
}

export default function ChatbotWorkspaceNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isFlowWorkspace = pathname.startsWith("/bot-builder/") && !pathname.startsWith("/bot-builder/routes");

  if (isFlowWorkspace) return null;

  const activeItem = workspaceItems.find((item) => isItemActive(pathname, item));

  return (
    <header className="mb-4 border-b border-border/80 pb-2" aria-label="Flowbot workspace navigation">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-semibold">Flowbot</p>
              <span className="hidden text-xs text-muted-foreground xl:inline">Build, test and operate customer automation</span>
            </div>
            <p className="truncate text-xs text-muted-foreground md:hidden">{activeItem?.label ?? "Workspace"}</p>
          </div>
        </div>

        <button
          type="button"
          className="btn-secondary min-h-11 min-w-11 p-0 md:hidden"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? "Close Flowbot navigation" : "Open Flowbot navigation"}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
        </button>
      </div>

      <nav className="hidden items-center gap-1 overflow-x-auto pb-1 md:flex [scrollbar-width:thin]" aria-label="Flowbot sections">
        {workspaceItems.map((item) => <WorkspaceLink key={item.href} item={item} pathname={pathname} />)}
      </nav>

      {mobileOpen ? (
        <nav className="grid grid-cols-2 gap-1 pt-2 sm:grid-cols-3 md:hidden" aria-label="Flowbot sections">
          {workspaceItems.map((item) => (
            <WorkspaceLink key={item.href} item={item} pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          ))}
        </nav>
      ) : null}
    </header>
  );
}
