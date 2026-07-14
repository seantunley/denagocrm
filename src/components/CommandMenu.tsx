"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search, Settings, Trash2 } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { buildNav } from "@/components/nav-config";
import { SETTINGS_NAV_GROUPS, settingsHref } from "@/lib/settings-navigation";

const QUICK_ACTIONS = [
  { href: "/leads/new", label: "New lead", icon: Plus },
  { href: "/contacts/new", label: "New contact", icon: Plus },
  { href: "/jobcards/new", label: "New job card", icon: Plus },
  { href: "/search", label: "Search everything", icon: Search },
];

export function openCommandMenu() {
  window.dispatchEvent(new Event("denago:open-command"));
}

export default function CommandMenu({
  modules,
  isAdmin,
}: {
  modules: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { topLinks, groups } = buildNav(modules, isAdmin);
  const settingsGroups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => isAdmin || item.key === "account"),
  })).filter((group) => group.items.length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("denago:open-command", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("denago:open-command", onOpen);
    };
  }, []);

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command menu" description="Search and navigate">
      <CommandInput placeholder="Search pages, settings, or actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Quick actions">
          {QUICK_ACTIONS.map((a) => (
            <CommandItem key={a.href} value={`action ${a.label}`} onSelect={() => go(a.href)}>
              <a.icon className="size-4 text-muted-foreground" />
              {a.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {topLinks.map((l) => (
            <CommandItem key={l.href} value={`page ${l.label}`} onSelect={() => go(l.href)}>
              <l.icon className="size-4 text-muted-foreground" />
              {l.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {groups.map((group) => (
          <CommandGroup key={group.key} heading={group.label}>
            {group.links.map((l) => (
              <CommandItem key={l.href} value={`${group.label} ${l.label}`} onSelect={() => go(l.href)}>
                <l.icon className="size-4 text-muted-foreground" />
                {l.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <CommandSeparator />
        <CommandGroup heading="Settings">
          {settingsGroups.flatMap((group) =>
            group.items.map((item) => (
              <CommandItem
                key={item.key}
                value={`settings ${group.label} ${item.label} ${item.key} ${item.keywords?.join(" ") ?? ""}`}
                onSelect={() => go(settingsHref(item))}
              >
                <Settings className="size-4 text-muted-foreground" />
                <span className="flex-1">{item.label}</span>
                <span className="text-xs text-muted-foreground">{group.label}</span>
              </CommandItem>
            ))
          )}
        </CommandGroup>

        {isAdmin && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Account">
              <CommandItem value="trash" onSelect={() => go("/trash")}>
                <Trash2 className="size-4 text-muted-foreground" />
                Trash
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
