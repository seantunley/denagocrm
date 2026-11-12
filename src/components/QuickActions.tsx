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
import { isPathEnabled } from "@/lib/modules/registry";
import { midSentence } from "@/lib/recordLabels";
import { useRecordLabels } from "@/components/RecordLabelsProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function QuickActions({
  isAdmin,
  permissions = [],
  enabledModules,
}: {
  isAdmin: boolean;
  permissions?: string[];
  enabledModules?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const labels = useRecordLabels();
  const granted = new Set(permissions);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => granted.has(key));
  const enabledSet = enabledModules ? new Set(enabledModules) : undefined;
  const packOn = (href: string) => !enabledSet || isPathEnabled(href, enabledSet);
  // Creating a job card requires picking a vehicle, and the vehicle picker is
  // empty without a vehicle-view permission — so require both, or the action is a
  // dead end (mirrors the /api/quick-create gate).
  const canJobcards =
    can("jobcards.manage") && can("vehicles.view_all", "vehicles.view_owned") && packOn("/jobcards");
  const canVehicles = can("vehicles.manage") && packOn("/vehicles");
  const hasCrmActions = can("leads.create", "contacts.create", "activities.manage", "quotes.create");
  const hasWorkshopActions = canJobcards || canVehicles;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "n" && event.key !== "N") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
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
        <button className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] bg-primary depth-sheen px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 pointer-fine:min-h-9">
          <Plus className="size-4" />
          <span className="flex-1 text-left">Quick actions</span>
          <kbd className="rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-[10px] font-medium">N</kbd>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" sideOffset={6}>
        {hasCrmActions && (
          <>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">CRM</DropdownMenuLabel>
            {can("leads.create") && (
              <DropdownMenuItem onSelect={() => create("lead")}>
                <SquareKanban className="size-4" />New {midSentence(labels.lead.one)}
              </DropdownMenuItem>
            )}
            {can("contacts.create") && (
              <DropdownMenuItem onSelect={() => create("contact")}>
                <UserPlus className="size-4" />New contact
              </DropdownMenuItem>
            )}
            {can("activities.manage") && (
              <DropdownMenuItem onSelect={() => create("calendar")}>
                <CalendarPlus className="size-4" />New calendar item
              </DropdownMenuItem>
            )}
            {can("quotes.create") && (
              <DropdownMenuItem onSelect={() => create("quote")}>
                <FileText className="size-4" />New quote
              </DropdownMenuItem>
            )}
          </>
        )}
        {hasCrmActions && hasWorkshopActions && <DropdownMenuSeparator />}
        {hasWorkshopActions && (
          <>
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">Workshop</DropdownMenuLabel>
            {canJobcards && (
              <DropdownMenuItem onSelect={() => create("jobcard")}>
                <Wrench className="size-4" />New {midSentence(labels.jobcard.one)}
              </DropdownMenuItem>
            )}
            {canVehicles && (
              <>
                <DropdownMenuItem onSelect={() => create("vehicle")}>
                  <CarFront className="size-4" />Register vehicle
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => go("/vehicles")}>
                  <BatteryCharging className="size-4" />Log battery check
                  <DropdownMenuShortcut>pick cart</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
