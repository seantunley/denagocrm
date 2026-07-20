"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/messages", label: "Chats", icon: MessageSquare },
  { href: "/messages/cases", label: "Help desk", icon: LifeBuoy },
];

export default function MessagesNav() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/messages" ? pathname === "/messages" : pathname.startsWith(href);

  return (
    <nav className="grid grid-cols-2 gap-1 border-t border-sidebar-border bg-sidebar/95 p-1.5 backdrop-blur-xl">
      {TABS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium transition-colors",
            active(href)
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
          )}
        >
          <Icon className="size-[18px]" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
