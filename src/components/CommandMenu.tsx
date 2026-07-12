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

export function openCommandMenu() {
  window.dispatchEvent(new Event("denago:open-command"));
}

export default function CommandMenu({
  modules,
  isAdmin,
  permissions = [],
}: {
  modules: string;
  isAdmin: boolean;
  permissions?: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { topLinks, groups } = buildNav(modules, isAdmin, permissions);
  const granted = new Set(permissions);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => granted.has(key));
  const quickActions = [
    ...(can("leads.create") ? [{ href: "/leads/new", label: "New lead", icon: Plus }] : []),
    ...(can("contacts.create") ? [{ href: "/contacts/new", label: "New contact", icon: Plus }] : []),
    ...(can("jobcards.manage") ? [{ href: "/jobcards/new", label: "New job card", icon: Plus }] : []),
    { href: "/search", label: "Search accessible records", icon: Search },
  ];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
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
      <CommandInput placeholder="Search pages or run an action…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Quick actions">
          {quickActions.map((action) => (
            <CommandItem key={action.href} value={`action ${action.label}`} onSelect={() => go(action.href)}>
              <action.icon className="size-4 text-muted-foreground" />
              {action.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Go to">
          {topLinks.map((link) => (
            <CommandItem key={link.href} value={`page ${link.label}`} onSelect={() => go(link.href)}>
              <link.icon className="size-4 text-muted-foreground" />
              {link.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {groups.map((group) => (
          <CommandGroup key={group.key} heading={group.label}>
            {group.links.map((link) => (
              <CommandItem key={link.href} value={`${group.label} ${link.label}`} onSelect={() => go(link.href)}>
                <link.icon className="size-4 text-muted-foreground" />
                {link.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}

        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem value="settings" onSelect={() => go("/settings")}>
            <Settings className="size-4 text-muted-foreground" />
            Settings
          </CommandItem>
          {isAdmin && (
            <CommandItem value="trash" onSelect={() => go("/trash")}>
              <Trash2 className="size-4 text-muted-foreground" />
              Trash
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
