"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  SquareKanban,
  UserPlus,
  CalendarPlus,
  FileText,
  Wrench,
  CarFront,
  BatteryCharging,
} from "lucide-react";
import { openQuickCreate } from "@/components/QuickCreateDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Sidebar "create anything" menu. Also opens with N anywhere in the app
 * (outside text inputs) — the fastest path to a new record.
 */
export default function QuickActions({
  modules,
  isAdmin,
}: {
  modules: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const mods = new Set(modules.split(",").map((m) => m.trim()).filter(Boolean));
  const has = (m: string) => isAdmin || mods.has(m);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => router.push(href);
  const create = (kind: Parameters<typeof openQuickCreate>[0]) => openQuickCreate(kind);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md bg-primary px-2.5 py-1.5 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">
          <Plus className="size-4" />
          <span className="flex-1 text-left">Quick actions</span>
          <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">
            N
          </kbd>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" sideOffset={6}>
        {has("crm") && (
          <>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
              CRM
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => create("lead")}>
              <SquareKanban className="size-4" />
              New lead
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => create("contact")}>
              <UserPlus className="size-4" />
              New contact
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => create("calendar")}>
              <CalendarPlus className="size-4" />
              New calendar item
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => create("quote")}>
              <FileText className="size-4" />
              New quote
            </DropdownMenuItem>
          </>
        )}
        {has("crm") && has("workshop") && <DropdownMenuSeparator />}
        {has("workshop") && (
          <>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Workshop
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => create("jobcard")}>
              <Wrench className="size-4" />
              New job card
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => create("vehicle")}>
              <CarFront className="size-4" />
              Register vehicle
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => go("/vehicles")}>
              <BatteryCharging className="size-4" />
              Log battery check
              <DropdownMenuShortcut>pick cart</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
