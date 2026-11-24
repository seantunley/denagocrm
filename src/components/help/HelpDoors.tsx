"use client";

import Link from "next/link";
import { ArrowRight, NotebookPen, Sparkles } from "lucide-react";
import { useUnseenWhatsNew } from "@/components/help/WhatsNewDot";

/**
 * Two doors beside the reader's path on the help home: what changed lately,
 * and the workspace's own guides. Each fills half the column's height so the
 * pair stands as tall as the path card next to it.
 */
export default function HelpDoors({
  latest,
  guideCount,
  canWrite,
}: {
  latest: { title: string; text: string } | null;
  guideCount: number;
  canWrite: boolean;
}) {
  const unseen = useUnseenWhatsNew();
  const showGuides = guideCount > 0 || canWrite;
  if (!latest && !showGuides) return null;

  const card = "group flex flex-1 flex-col gap-2 rounded-2xl border border-border bg-card p-5 transition-colors depth-card hover:border-primary/35";
  const label = "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground";
  const more = "mt-auto inline-flex items-center gap-1 pt-1 text-sm font-medium text-primary";
  return (
    <div className="flex h-full flex-col gap-4">
      {latest && (
        <Link href="/help/whats-new" className={card}>
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
              <Sparkles className="size-4" />
              {unseen > 0 && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary ring-2 ring-card" />}
            </span>
            <span className={label}>What&apos;s new{unseen > 0 ? ` · ${unseen} you haven't seen` : ""}</span>
          </span>
          <span className="font-semibold leading-snug text-foreground">{latest.title}</span>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">{latest.text}</span>
          <span className={more}>See what changed <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
        </Link>
      )}
      {showGuides && (
        <Link href="/help/ours" className={card}>
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300">
              <NotebookPen className="size-4" />
            </span>
            <span className={label}>Our own guides</span>
          </span>
          <span className="font-semibold leading-snug text-foreground">
            {guideCount > 0 ? `${guideCount} guide${guideCount === 1 ? "" : "s"} written for this workspace` : "Write your workspace's first guide"}
          </span>
          <span className="line-clamp-2 text-[13px] text-muted-foreground">How this business does things: trade-ins, the delivery checklist, who approves a discount.</span>
          <span className={more}>{guideCount > 0 ? "Read them" : "Write one"} <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" /></span>
        </Link>
      )}
    </div>
  );
}
