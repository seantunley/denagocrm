"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, MessageSquare, LifeBuoy } from "lucide-react";
import { cn } from "@/lib/utils";
import PushToggle from "@/components/PushToggle";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const TABS = [
  { href: "/messages", label: "Chats", icon: MessageSquare },
  { href: "/messages/cases", label: "Help desk", icon: LifeBuoy },
];

export default function MessagesNav() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/messages" ? pathname === "/messages" : pathname.startsWith(href);

  return (
    <nav
      aria-label="Messages navigation"
      className="grid grid-cols-3 gap-1 border-t border-sidebar-border bg-sidebar/95 p-1.5 backdrop-blur-xl"
    >
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

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[state=open]:bg-primary/10 data-[state=open]:text-primary"
          >
            <Bell className="size-[18px]" />
            Notifications
          </button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] overflow-y-auto rounded-t-3xl border-sidebar-border bg-background p-0"
        >
          <SheetHeader className="border-b border-border px-5 pb-4 pt-6 text-left">
            <SheetTitle>Notifications</SheetTitle>
            <SheetDescription>
              Get alerted when new messages and leads arrive.
            </SheetDescription>
          </SheetHeader>
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <PushToggle mode="messages" />
          </div>
        </SheetContent>
      </Sheet>
    </nav>
  );
}
