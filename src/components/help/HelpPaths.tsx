"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { featuredPathKey, parseRead, pathProgress } from "@/lib/help/paths";
import { readRaw, subscribeRead } from "@/lib/help/readStore";

export type HelpPathView = { key: string; label: string; blurb: string; articles: { slug: string; title: string }[] };

const track = "h-2.5 overflow-hidden rounded-full depth-track";

/**
 * Guided paths on the help home (lib/help/paths.ts), laid out as the design
 * has it: ONE path in full — the one the reader is part-way through, else the
 * first they have not finished — with whatever the page passes as `beside`
 * next to it, and the other paths as a row of compact cards underneath.
 *
 * Only one list is ever open. Five lists side by side was a wall of titles,
 * and cards of unequal length left holes in the grid.
 *
 * The ticks live in this browser (lib/help/readStore.ts), so the server renders
 * every path unread and the ticks appear once the page is live.
 */
export default function HelpPaths({ paths, storageKey, beside }: { paths: HelpPathView[]; storageKey: string; beside?: ReactNode }) {
  const raw = useSyncExternalStore(subscribeRead, () => readRaw(storageKey), () => "");
  const read = useMemo(() => parseRead(raw), [raw]);
  if (paths.length === 0) return beside ? <section>{beside}</section> : null;

  const key = featuredPathKey(paths.map((path) => ({ key: path.key, slugs: path.articles.map((article) => article.slug) })), read);
  const main = paths.find((path) => path.key === key) ?? paths[0];
  const others = paths.filter((path) => path.key !== main.key);
  const mainProgress = pathProgress(main.articles.map((article) => article.slug), read);
  const mainNext = main.articles.find((article) => article.slug === mainProgress.next) ?? null;
  const percent = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

  return (
    <section aria-labelledby="help-paths" className="space-y-4">
      <div className={cn("grid gap-4", beside && "lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]")}>
        <div className="grid min-w-0 gap-6 rounded-2xl border border-border bg-card p-5 depth-card sm:grid-cols-2 sm:p-6">
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Your path · {main.label}</p>
            <h2 id="help-paths" className="text-xl font-semibold tracking-tight text-foreground">
              {mainProgress.complete ? "All read — well done" : mainProgress.done > 0 ? "Pick up where you left off" : "Start here"}
            </h2>
            <p className="text-sm text-muted-foreground">{main.blurb} A guide is ticked once you have opened it on this device.</p>
            <div>
              <div role="progressbar" aria-label={`${main.label}: guides read`} aria-valuemin={0} aria-valuemax={mainProgress.total} aria-valuenow={mainProgress.done} className={track}>
                {/* An inline width: a measured value, not a design token. */}
                <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent(mainProgress.done, mainProgress.total)}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{mainProgress.done} of {mainProgress.total} read</p>
            </div>
            {mainNext && (
              <Link href={`/help/${mainNext.slug}`} className="btn-primary mt-auto max-w-full self-start">
                <span className="truncate">{mainProgress.done === 0 ? "Start" : "Continue"}: {mainNext.title}</span>
                <ArrowRight className="size-4 shrink-0" aria-hidden />
              </Link>
            )}
          </div>
          <ol className="min-w-0 space-y-0.5">
            {main.articles.map((article, index) => {
              const done = read.has(article.slug);
              return (
                <li key={article.slug}>
                  <Link href={`/help/${article.slug}`} className="flex min-h-10 items-center gap-3 rounded-lg px-1.5 py-1 text-sm transition-colors hover:bg-white/[0.04]">
                    <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold", done ? "bg-primary text-primary-foreground" : "text-muted-foreground depth-inset")}>
                      {done ? <Check className="size-3.5" /> : index + 1}
                    </span>
                    <span className={cn("min-w-0 truncate", done ? "text-muted-foreground" : "text-foreground")}>{article.title}</span>
                    <span className="sr-only">{done ? "(read)" : "(not read yet)"}</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
        {beside && <div className="min-w-0">{beside}</div>}
      </div>

      {others.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">More paths</h3>
          {/* As many columns as fit, so three, four or five paths each fill the row with no orphan. */}
          <div className="grid gap-4 grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
            {others.map((path) => {
              const progress = pathProgress(path.articles.map((article) => article.slug), read);
              const next = path.articles.find((article) => article.slug === progress.next) ?? path.articles[0];
              return (
                <Link
                  key={path.key}
                  href={`/help/${next.slug}`}
                  className="group flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-4 transition-[transform,border-color] depth-card hover:-translate-y-0.5 hover:border-white/15"
                >
                  <span className="font-semibold text-foreground">{path.label}</span>
                  <span className="text-[13px] text-muted-foreground">{path.blurb}</span>
                  <span className="mt-auto block pt-1">
                    <span role="progressbar" aria-label={`${path.label}: guides read`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className={cn("block", track)}>
                      <span className="block h-full rounded-full bg-primary" style={{ width: `${percent(progress.done, progress.total)}%` }} />
                    </span>
                    <span className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{progress.complete ? "All read" : `${progress.done} of ${progress.total} read`}</span>
                      <span className="inline-flex items-center gap-1 font-medium transition-colors group-hover:text-primary">
                        {progress.complete ? "Read again" : progress.done > 0 ? "Continue" : "Start"} <ArrowRight className="size-3" aria-hidden />
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
