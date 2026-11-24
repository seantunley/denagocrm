"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { rankHelp } from "@/lib/help/quickSearch";
import { HelpAreaTag } from "@/components/help/HelpAreaIcon";
import type { HelpCategoryKey } from "@/lib/help/types";

export type HelpSearchItem = { slug: string; title: string; summary: string; keywords: string[]; area: HelpCategoryKey; areaLabel: string };

/**
 * The help centre's front-page search: the first thing on the page, not a box
 * in the side menu. Results appear under it as you type (lib/help/quickSearch.ts);
 * nothing is sent anywhere — the guides it searches arrived with the page.
 */
export default function HelpSearch({ items }: { items: HelpSearchItem[] }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const results = useMemo(() => rankHelp(items, query), [items, query]);
  const searching = query.trim().length > 0;

  return (
    <div className="w-full max-w-2xl">
      <form role="search" onSubmit={(event) => event.preventDefault()} className="relative">
        <label htmlFor={id} className="sr-only">Search the help centre</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search guides, or describe what you want to do"
          autoComplete="off"
          className="h-14 w-full rounded-2xl border border-white/10 bg-popover pl-12 pr-12 text-base text-foreground outline-none depth-float-shadow placeholder:text-muted-foreground focus:border-primary/60 [&::-webkit-search-cancel-button]:hidden"
        />
        {searching && (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2 top-1/2 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-lg text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </form>

      <div aria-live="polite" className="text-left">
        {searching && (
          <div className="mt-3 rounded-2xl border border-white/10 bg-popover p-1.5 depth-float-shadow">
            {results.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No guides match “{query.trim()}”. Try fewer or different words.</p>
            ) : (
              <ul>
                {results.map((item) => (
                  <li key={item.slug}>
                    <Link href={`/help/${item.slug}`} className="flex min-h-11 flex-col gap-1 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.05] sm:flex-row sm:items-center sm:gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.summary}</span>
                      </span>
                      <span className="shrink-0"><HelpAreaTag area={item.area} label={item.areaLabel} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
