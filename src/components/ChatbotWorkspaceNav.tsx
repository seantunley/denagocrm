"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BookOpenCheck,
  Bot,
  FlaskConical,
  GitBranch,
  Inbox,
  Menu,
  Route,
  X,
} from "lucide-react";
import ModalPortal from "@/components/ui/modal-portal";

type WorkspaceItem = {
  label: string;
  href: string;
  icon: typeof Bot;
  exact?: boolean;
};

function isItemActive(pathname: string, item: WorkspaceItem) {
  if (item.exact) return pathname === item.href;
  const path = item.href.split("?")[0];
  if (path === "/bot-builder" && pathname.startsWith("/bot-builder/routes")) return false;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function WorkspaceLink({ item, pathname, onNavigate }: { item: WorkspaceItem; pathname: string; onNavigate?: () => void }) {
  const Icon = item.icon;
  const active = isItemActive(pathname, item);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition ${
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

function NavGroup({ label, items, pathname, onNavigate }: { label: string; items: WorkspaceItem[]; pathname: string; onNavigate?: () => void }) {
  return (
    <div>
      <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">{label}</p>
      <div className="space-y-1">
        {items.map((item) => <WorkspaceLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />)}
      </div>
    </div>
  );
}

export default function ChatbotWorkspaceNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const closeMobileNav = () => {
    setMobileOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  const configure: WorkspaceItem[] = [
    { label: "Overview", href: "/chatbot", icon: Bot, exact: true },
    { label: "Flows", href: "/bot-builder", icon: GitBranch },
    { label: "Routing", href: "/bot-builder/routes", icon: Route },
    { label: "Knowledge", href: "/chatbot/knowledge", icon: BookOpenCheck },
  ];
  const test: WorkspaceItem[] = [
    { label: "AI preview", href: "/chatbot/preview", icon: FlaskConical },
  ];
  const operate: WorkspaceItem[] = [
    { label: "Handoffs", href: "/inbox", icon: Inbox },
    { label: "Analytics", href: "/bot-analytics", icon: BarChart3 },
  ];

  const nav = (
    <>
      <NavGroup label="Configure" items={configure} pathname={pathname} onNavigate={closeMobileNav} />
      <NavGroup label="Test" items={test} pathname={pathname} onNavigate={closeMobileNav} />
      <NavGroup label="Operate" items={operate} pathname={pathname} onNavigate={closeMobileNav} />
    </>
  );

  return (
    <>
      <div className="sticky top-0 z-20 -mx-1 mb-4 flex items-center justify-between gap-3 border-b border-border/70 bg-background/95 px-1 py-2 backdrop-blur lg:hidden">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Flowbot workspace</p>
          <p className="truncate text-sm font-semibold">Chatbot</p>
        </div>
        <button ref={menuButtonRef} type="button" className="btn-secondary min-h-11 min-w-11 p-0" onClick={() => setMobileOpen(true)} aria-label="Open Flowbot navigation" aria-expanded={mobileOpen}>
          <Menu className="size-4" aria-hidden="true" />
        </button>
      </div>

      {mobileOpen ? (
        <ModalPortal>
          <div className="fixed inset-0 z-[90] lg:hidden" role="dialog" aria-label="Flowbot navigation">
            <button className="absolute inset-0 bg-black/55" aria-label="Close Flowbot navigation" onClick={closeMobileNav} />
            <div className="absolute inset-y-0 left-0 w-[min(88vw,340px)] overflow-y-auto border-r border-border bg-background p-4 shadow-2xl">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Flowbot workspace</p>
                  <p className="mt-1 font-semibold">Chatbot</p>
                </div>
                <button ref={closeButtonRef} type="button" className="btn-secondary min-h-11 min-w-11 p-0" onClick={closeMobileNav} aria-label="Close Flowbot navigation"><X className="size-4" aria-hidden="true" /></button>
              </div>
              <div className="space-y-5">{nav}</div>
            </div>
          </div>
        </ModalPortal>
      ) : null}

      <aside className="sticky top-4 hidden h-fit w-56 shrink-0 rounded-2xl border border-border bg-card/70 p-3 shadow-sm lg:block" aria-label="Flowbot workspace navigation">
        <div className="mb-4 border-b border-border/70 px-2 pb-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-primary" aria-hidden="true" />Flowbot</div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">Build, test and operate customer automation.</p>
        </div>
        <div className="space-y-5">{nav}</div>
      </aside>
    </>
  );
}
