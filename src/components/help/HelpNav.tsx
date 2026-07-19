"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type HelpNavArticle = { slug: string; title: string; summary: string; keywords: string[] };
export type HelpNavGroup = { key: string; label: string; articles: HelpNavArticle[] };

export default function HelpNav({ groups }: { groups: HelpNavGroup[] }) {
  const pathname = usePathname();
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return null;
    const terms = query.split(/\s+/).filter(Boolean);
    const flat = groups.flatMap((g) => g.articles.map((a) => ({ ...a, group: g.label })));
    return flat
      .map((a) => {
        const hay = `${a.title} ${a.summary} ${a.keywords.join(" ")}`.toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (a.title.toLowerCase().includes(t)) score += 6;
          if (hay.includes(t)) score += 2;
        }
        return { a, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
  }, [q, groups]);

  return (
    <nav className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the manual…"
          className="w-full rounded-lg border border-border bg-background/40 py-2 pl-9 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
        {q && (
          <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear">
            <X className="size-4" />
          </button>
        )}
      </div>

      {results ? (
        <div className="flex flex-col gap-0.5">
          {results.length === 0 && <p className="px-2 py-4 text-sm text-muted-foreground">No matches for “{q}”.</p>}
          {results.map((a) => (
            <Link
              key={a.slug}
              href={`/help/${a.slug}`}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground",
                pathname === `/help/${a.slug}` && "bg-primary/10 text-primary",
              )}
            >
              <span className="block truncate">{a.title}</span>
              <span className="block truncate text-[11px] text-muted-foreground/60">{a.group}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.key}>
              <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{g.label}</p>
              <div className="flex flex-col gap-0.5">
                {g.articles.map((a) => {
                  const active = pathname === `/help/${a.slug}`;
                  return (
                    <Link
                      key={a.slug}
                      href={`/help/${a.slug}`}
                      className={cn(
                        "truncate rounded-md px-2.5 py-1.5 text-sm transition-colors",
                        active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                      )}
                    >
                      {a.title}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
