"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, NotebookPen, Sparkles } from "lucide-react";
import { useUnseenWhatsNew } from "@/components/help/WhatsNewDot";

/**
 * Two doors at the top of the help HOME only: what changed lately, and the
 * workspace's own guides. In the help layout rather than the home page so it
 * reaches phones too (the side menu is desktop-only) — the layout cannot know
 * the path, so this asks.
 */
export default function HelpHomeStrip({
  latest,
  guideCount,
  canWrite,
}: {
  latest: { title: string; date: string } | null;
  guideCount: number;
  canWrite: boolean;
}) {
  const pathname = usePathname();
  const unseen = useUnseenWhatsNew();
  if (pathname !== "/help") return null;
  const showGuides = guideCount > 0 || canWrite;
  if (!latest && !showGuides) return null;

  const card = "group flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-card p-3.5 transition-colors depth-card hover:border-primary/35";
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-2">
      {latest && (
        <Link href="/help/whats-new" className={card}>
          <span aria-hidden className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
            <Sparkles className="size-[18px]" />
            {unseen > 0 && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              What&apos;s new{unseen > 0 ? ` · ${unseen} you haven't seen` : ""}
            </span>
            <span className="block truncate text-sm font-medium text-foreground">{latest.title}</span>
          </span>
          <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </Link>
      )}
      {showGuides && (
        <Link href="/help/ours" className={card}>
          <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300">
            <NotebookPen className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Our own guides</span>
            <span className="block truncate text-sm font-medium text-foreground">
              {guideCount > 0 ? `${guideCount} guide${guideCount === 1 ? "" : "s"} written for this workspace` : "Write your workspace's first guide"}
            </span>
          </span>
          <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </Link>
      )}
    </div>
  );
}
