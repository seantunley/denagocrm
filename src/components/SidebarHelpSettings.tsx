"use client";

import { Fragment } from "react";
import Link from "next/link";
import {
  LifeBuoy, Settings, BookOpen, FileText, Rocket, Keyboard, Info, ChevronRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openCommandMenu } from "@/components/CommandMenu";
import { APP_VERSION } from "@/lib/version";
import { SETTINGS_NAV_GROUPS, settingsHref } from "@/lib/settings-navigation";

const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

export default function SidebarHelpSettings({ isOwner }: { isOwner: boolean }) {
  // Members only see their own account-level settings; owners see everything.
  const settingsGroups = isOwner ? SETTINGS_NAV_GROUPS : SETTINGS_NAV_GROUPS.filter((g) => g.label === "You");

  return (
    <div className="space-y-0.5">
      {/* Help flyout */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={ROW}>
            <LifeBuoy className="size-4" />
            <span className="flex-1 text-left">Help</span>
            <ChevronRight className="size-3.5 text-muted-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
          <DropdownMenuItem asChild>
            <Link href="/help/finding-your-way-around"><Rocket className="size-4" /> Quickstart</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/help"><BookOpen className="size-4" /> User manual</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/manual" target="_blank"><FileText className="size-4" /> Full manual · PDF</Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); openCommandMenu(); }}>
            <Keyboard className="size-4" /> Search &amp; shortcuts
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/help/welcome"><Info className="size-4" /> About · v{APP_VERSION}</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Settings flyout */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className={ROW}>
            <Settings className="size-4" />
            <span className="flex-1 text-left">Settings</span>
            <ChevronRight className="size-3.5 text-muted-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" sideOffset={8} className="max-h-[72vh] w-56 overflow-y-auto">
          {settingsGroups.map((g, gi) => (
            <Fragment key={g.label}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{g.label}</DropdownMenuLabel>
              {g.items.map((item) => (
                <DropdownMenuItem key={item.key} asChild>
                  <Link href={settingsHref(item)}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
