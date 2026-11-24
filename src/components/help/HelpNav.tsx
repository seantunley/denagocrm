"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { rankHelp } from "@/lib/help/quickSearch";

export type HelpNavArticle = { slug: string; title: string; summary: string; keywords: string[] };
export type HelpNavGroup = { key: string; label: string; articles: HelpNavArticle[] };

/**
 * The menu beside a guide (2026-11-24; the canvas board "Help centre —
 * article"): a way back, a search of every guide, the guides of THE AREA BEING
 * READ, and the other areas by name.
 *
 * It used to list every guide in every area — about two hundred titles down
 * the side of every article. The reader is in one area; the rest are one click
 * away as eleven names, and the search still reaches all of them.
 */
export default function HelpNav({ groups }: { groups: HelpNavGroup[] }) {
  const pathname = usePathname();
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    if (!q.trim()) return null;
    const flat = groups.flatMap((g) => g.articles.map((a) => ({ ...a, group: g.label })));
    return rankHelp(flat, q, 12);
  }, [q, groups]);

  const current = groups.find((g) => g.articles.some((a) => pathname === `/help/${a.slug}`)) ?? null;
  const others = groups.filter((g) => g !== current && g.articles.length > 0);
  const row = "flex min-h-9 items-center rounded-lg px-2.5 py-1.5 text-sm leading-snug transition-colors";

  return (
    <nav aria-label="Help" className="flex flex-col gap-4">
      <Link href="/help" className="inline-flex min-h-9 items-center gap-1.5 self-start text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> All help
      </Link>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search all guides…"
          aria-label="Search all guides"
          className="h-10 w-full rounded-lg border border-border bg-background/40 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
        {q && (
          <button type="button" onClick={() => setQ("")} className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center text-muted-foreground hover:text-foreground" aria-label="Clear search" title="Clear search">
            <X className="size-4" />
          </button>
        )}
      </div>

      {results ? (
        <div className="flex flex-col gap-0.5">
          {results.length === 0 && <p className="px-2.5 py-3 text-sm text-muted-foreground">No guides match “{q.trim()}”.</p>}
          {results.map((a) => (
            <Link key={a.slug} href={`/help/${a.slug}`} className={cn(row, "flex-col items-start text-muted-foreground hover:bg-white/[0.04] hover:text-foreground", pathname === `/help/${a.slug}` && "bg-primary/10 text-primary")}>
              <span>{a.title}</span>
              <span className="text-[11px] text-muted-foreground/70">{a.group}</span>
            </Link>
          ))}
        </div>
      ) : (
        <>
          {current && (
            <div>
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{current.label}</p>
              <div className="flex flex-col gap-0.5">
                {current.articles.map((a) => {
                  const active = pathname === `/help/${a.slug}`;
                  return (
                    <Link
                      key={a.slug}
                      href={`/help/${a.slug}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(row, active ? "bg-white/[0.07] font-semibold text-foreground depth-secondary" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")}
                    >
                      {a.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{current ? "Other areas" : "Areas"}</p>
              <div className="flex flex-col gap-0.5">
                {others.map((g) => (
                  <Link key={g.key} href={`/help/${g.articles[0].slug}`} className={cn(row, "group justify-between gap-2 text-muted-foreground hover:bg-white/[0.04] hover:text-foreground")}>
                    <span>{g.label}</span>
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
                      {g.articles.length}
                      <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </nav>
  );
}
