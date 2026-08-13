"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Car,
  FileText,
  Plus,
  Search,
  Settings,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
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
import { isPathEnabled } from "@/lib/modules/registry";
import { SETTINGS_NAV_GROUPS, settingsHref, settingsItemEnabled } from "@/lib/settings-navigation";
import { MIN_SEARCH_TERM, searchRecords, type SearchHit } from "@/app/actions/search";

export function openCommandMenu() {
  window.dispatchEvent(new Event("denago:open-command"));
}

export default function CommandMenu({
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
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * Which search the results on screen belong to.
   *
   * Keystrokes race: "sm" can answer after "smith" and repaint the older, wider
   * result set over the newer one. Comparing the term a response was asked for
   * against the term now in the box drops the loser instead of showing it.
   */
  const latest = useRef("");
  const enabledSet = enabledModules ? new Set(enabledModules) : undefined;
  const { topLinks, groups } = buildNav(isAdmin, permissions, enabledSet);
  const granted = new Set(permissions);
  const can = (...keys: string[]) => isAdmin || keys.some((key) => granted.has(key));
  const packOn = (href: string) => !enabledSet || isPathEnabled(href, enabledSet);
  const quickActions = [
    ...(can("leads.create") ? [{ href: "/leads/new", label: "New lead", icon: Plus }] : []),
    ...(can("contacts.create") ? [{ href: "/contacts/new", label: "New contact", icon: Plus }] : []),
    ...(can("jobcards.manage") ? [{ href: "/jobcards/new", label: "New job card", icon: Plus }] : []),
    { href: "/search", label: "Search accessible records", icon: Search },
  ].filter((action) => packOn(action.href));
  const settingsGroups = SETTINGS_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => (isAdmin || item.key === "account") && settingsItemEnabled(item, enabledSet),
    ),
  })).filter((group) => group.items.length > 0);

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

  // Debounced record search. 200ms is long enough that typing a name is one
  // query rather than eight, and short enough that it still feels live.
  useEffect(() => {
    const query = term.trim();
    latest.current = query;
    // No state is set in this body on purpose. A term too short to search simply
    // renders nothing (see `visibleHits`), which keeps the effect free of the
    // synchronous setState the hooks lint rightly objects to.
    if (query.length < MIN_SEARCH_TERM) return;
    const timer = setTimeout(() => {
      setSearching(true);
      searchRecords(query)
        .then((results) => {
          if (latest.current !== query) return; // a newer keystroke owns the box
          setHits(results);
        })
        .catch(() => {
          // A failed lookup must not wipe the navigation results underneath it;
          // the palette still has to be usable as a menu.
          if (latest.current === query) setHits([]);
        })
        .finally(() => {
          if (latest.current === query) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [term]);

  /**
   * Reset between openings, so yesterday's search is not the first thing the
   * palette shows tomorrow.
   *
   * Done in the open/close HANDLER rather than an effect watching `open`: the
   * close is an event, and reacting to it after the fact is both a redundant
   * render and the synchronous setState the hooks lint warns about.
   */
  function setPaletteOpen(next: boolean) {
    setOpen(next);
    if (!next) {
      setTerm("");
      setHits([]);
      setSearching(false);
    }
  }

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  const RECORD_ICON = {
    contact: UserRound,
    lead: Search,
    quote: FileText,
    vehicle: Car,
    jobcard: Wrench,
  } as const;

  const RECORD_GROUP = {
    contact: "Customers",
    lead: "Leads",
    quote: "Quotes",
    vehicle: "Vehicles",
    jobcard: "Job cards",
  } as const;

  const searchable = term.trim().length >= MIN_SEARCH_TERM;
  // DERIVED, not cleared in an effect: a term too short to search shows nothing,
  // without a render pass whose only job is to empty a list.
  const visibleHits = searchable ? hits : [];

  const grouped = (["contact", "lead", "quote", "vehicle", "jobcard"] as const)
    .map((type) => ({ type, rows: visibleHits.filter((hit) => hit.type === type) }))
    .filter((group) => group.rows.length > 0);

  return (
    <CommandDialog open={open} onOpenChange={setPaletteOpen} title="Command menu" description="Search and navigate">
      {/* The placeholder now describes what the box actually does. It said
          "pages, settings, or actions" while being the only search field in the
          product, so typing a customer's name got a confident "No results". */}
      <CommandInput
        placeholder="Search customers, leads, quotes, pages…"
        value={term}
        onValueChange={setTerm}
      />
      <CommandList>
        <CommandEmpty>
          {searching && searchable ? "Searching…" : "No results found."}
        </CommandEmpty>

        {/* RECORDS FIRST. Somebody typing a name wants the customer, not the page
            whose title happens to share a letter with it. */}
        {grouped.map((group) => (
          <CommandGroup key={group.type} heading={RECORD_GROUP[group.type]}>
            {group.rows.map((hit) => {
              const Icon = RECORD_ICON[hit.type];
              return (
                <CommandItem
                  key={`${hit.type}-${hit.id}`}
                  // `cmdk` scores every item against the typed text and hides the
                  // ones it does not like. These rows were chosen by the SERVER,
                  // which matched fields the label does not even show — an email,
                  // a VIN, a phone number — so the client must not second-guess
                  // them. Including the term makes every server hit a match.
                  value={`record ${hit.type} ${hit.id} ${term}`}
                  onSelect={() => go(hit.href)}
                >
                  <Icon className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate">{hit.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{hit.sublabel}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}

        {searchable && (
          <CommandGroup heading="All results">
            <CommandItem
              value={`see-all ${term}`}
              onSelect={() => go(`/search?q=${encodeURIComponent(term.trim())}`)}
            >
              <Search className="size-4 text-muted-foreground" />
              <span className="flex-1">
                Search everything for “{term.trim()}”
              </span>
              <span className="text-xs text-muted-foreground">documents, products, custom fields</span>
            </CommandItem>
          </CommandGroup>
        )}

        {(grouped.length > 0 || searchable) && <CommandSeparator />}

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
