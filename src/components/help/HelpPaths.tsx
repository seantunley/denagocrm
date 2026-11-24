"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseRead, pathProgress } from "@/lib/help/paths";
import { readRaw, subscribeRead } from "@/lib/help/readStore";

export type HelpPathView = { key: string; label: string; blurb: string; articles: { slug: string; title: string }[] };

/**
 * Guided paths with a tick for each guide read (lib/help/paths.ts). The ticks
 * live in this browser (lib/help/readStore.ts), so the server renders every
 * path unread and the ticks appear once the page is live — never the reverse.
 */
export default function HelpPaths({ paths, storageKey }: { paths: HelpPathView[]; storageKey: string }) {
  const raw = useSyncExternalStore(subscribeRead, () => readRaw(storageKey), () => "");
  const read = useMemo(() => parseRead(raw), [raw]);
  if (paths.length === 0) return null;

  return (
    <section aria-labelledby="help-paths" className="space-y-3">
      <div>
        <h2 id="help-paths" className="text-lg font-semibold text-foreground">Guided paths</h2>
        <p className="text-sm text-muted-foreground">Short reading lists for the work you do. A guide is ticked once you have opened it on this device.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {paths.map((path, position) => {
          const progress = pathProgress(path.articles.map((article) => article.slug), read);
          const next = path.articles.find((article) => article.slug === progress.next) ?? null;
          const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
          return (
            <div key={path.key} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-5 depth-card">
              <div>
                <p className="font-semibold text-foreground">{path.label}</p>
                <p className="text-sm text-muted-foreground">{path.blurb}</p>
              </div>
              <div>
                <div
                  role="progressbar"
                  aria-label={`${path.label}: guides read`}
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                  className="h-2.5 overflow-hidden rounded-full depth-track"
                >
                  {/* An inline width: a measured value, not a design token. */}
                  <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {progress.complete ? "All read" : `${progress.done} of ${progress.total} read`}
                </p>
              </div>
              {/* The first path is open; the rest keep their guides folded away so five lists don't bury the page. */}
              <details open={position === 0} className="group/steps">
                <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 transition-transform group-open/steps:rotate-90" aria-hidden />
                  {path.articles.length} guides in this path
                </summary>
              <ol className="mt-1 space-y-0.5">
                {path.articles.map((article, index) => {
                  const done = read.has(article.slug);
                  return (
                    <li key={article.slug}>
                      <Link href={`/help/${article.slug}`} className="flex min-h-10 items-center gap-3 rounded-lg px-1.5 py-1 text-sm transition-colors hover:bg-white/[0.04]">
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                            done ? "bg-primary text-primary-foreground" : "text-muted-foreground depth-inset",
                          )}
                        >
                          {done ? <Check className="size-3.5" /> : index + 1}
                        </span>
                        <span className={cn("min-w-0 truncate", done ? "text-muted-foreground" : "text-foreground")}>{article.title}</span>
                        <span className="sr-only">{done ? "(read)" : "(not read yet)"}</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
              </details>
              {next && (
                <Link href={`/help/${next.slug}`} className="btn-primary mt-auto max-w-full self-start">
                  <span className="truncate">{progress.done === 0 ? "Start" : "Continue"}: {next.title}</span>
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
