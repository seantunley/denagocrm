"use client";

import Link from "next/link";
import { DaxIcon } from "@/components/DaxIcon";
import { formatZARCompact } from "@/lib/format";
import type { DaxBrief } from "@/lib/daxBriefRules";

/**
 * The DAX daily brief at the top of home. A client component only for the
 * "Ask DAX" button, which talks to the assistant bubble through a window event
 * rather than an import, so neither has to know where the other is mounted.
 *
 * The icon is imported HERE, never passed in: a server component handing a
 * component function to a client component crashes the render in Next 16.
 */

const ASK_FOR_PLAN = "Go through what needs my attention today and tell me what to do first.";

function askDax() {
  window.dispatchEvent(new CustomEvent("dax:ask", { detail: { question: ASK_FOR_PLAN } }));
}

export function DaxBriefCard({ brief }: { brief: DaxBrief }) {
  const empty = brief.items.length === 0 && !brief.team?.length;
  if (empty) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <DaxIcon className="size-4 shrink-0 text-primary" />
        {brief.summary}
      </p>
    );
  }

  return (
    <section className="card space-y-3" aria-label="DAX daily brief">
      <div className="flex items-start gap-2">
        <DaxIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{brief.summary}</p>
          {brief.attentionValueCents > 0 && (
            <p className="text-xs text-muted-foreground">
              Pipeline needing attention: {formatZARCompact(brief.attentionValueCents)}
            </p>
          )}
        </div>
      </div>

      {brief.items.length > 0 && (
        <ul className="space-y-0.5">
          {brief.items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
              >
                <span aria-hidden className="shrink-0 leading-5">{item.emoji}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{item.title}</span>
                  {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {brief.team && brief.team.length > 0 && (
        <details className="rounded-md border border-border/60 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Team</summary>
          <ul className="mt-2 space-y-1.5">
            {brief.team.map((row) => (
              <li key={row.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                <span className="font-medium text-foreground">{row.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {row.waiting} waiting · {row.overdue} overdue · {formatZARCompact(row.stalledValueCents)} stalled ·{" "}
                  {formatZARCompact(row.pipelineValueCents)} open
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap gap-2">
        <Link href="/today" className="btn-secondary btn-sm">Review all</Link>
        <button type="button" onClick={askDax} className="btn-primary btn-sm">
          <DaxIcon className="size-4" />
          Ask DAX for a plan
        </button>
      </div>
    </section>
  );
}
