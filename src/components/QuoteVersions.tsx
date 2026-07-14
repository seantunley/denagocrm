"use client";

import { useState } from "react";
import { ArrowRight, ExternalLink, History } from "lucide-react";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type QuoteVersion = {
  id: string;
  number: number;
  status: string; // draft | sent | accepted | declined
  superseded: boolean;
  createdAt: string; // pre-formatted
  declineReason: string | null;
  totalZAR: string; // pre-formatted
  items: { qty: number; description: string; colorPreference: string | null; priceZAR: string }[];
};

const STATUS_STYLE: Record<string, string> = {
  accepted: "bg-emerald-500/15 text-emerald-300",
  sent: "bg-sky-500/15 text-sky-300",
  declined: "bg-red-500/15 text-red-300",
  draft: "bg-muted text-muted-foreground",
  superseded: "bg-muted text-muted-foreground",
};

/**
 * Version chain for a quote. The current head is highlighted; older versions
 * open in a summary popup (with a jump to the full document) instead of
 * navigating away.
 */
export default function QuoteVersions({
  versions,
  currentId,
}: {
  versions: QuoteVersion[];
  currentId: string;
}) {
  const [viewing, setViewing] = useState<QuoteVersion | null>(null);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {versions.map((v, idx) => {
          const current = v.id === currentId;
          const label = v.superseded ? "superseded" : v.status;
          return (
            <div key={v.id} className="flex items-center gap-2">
              {idx > 0 && <ArrowRight className="size-3.5 text-muted-foreground/50" />}
              <button
                type="button"
                onClick={() => !current && setViewing(v)}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
                  current
                    ? "cursor-default border-primary/60 bg-primary/10"
                    : "border-border hover:border-primary/40 hover:bg-accent/50"
                )}
                title={current ? "This version" : `View Q-${v.number} (v${idx + 1})`}
              >
                <History className="size-3.5 text-muted-foreground" />
                <span className="font-semibold text-foreground">
                  v{idx + 1} · Q-{v.number}
                </span>
                <span className="tabular-nums text-muted-foreground">{v.totalZAR}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    STATUS_STYLE[label] ?? STATUS_STYLE.draft
                  )}
                >
                  {current ? `${label} · current` : label}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <ResponsiveDialogContent className="sm:max-w-lg">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  Quote Q-{viewing.number}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      STATUS_STYLE[viewing.superseded ? "superseded" : viewing.status]
                    )}
                  >
                    {viewing.superseded ? "superseded" : viewing.status}
                  </span>
                </DialogTitle>
              </DialogHeader>

              <p className="text-xs text-muted-foreground">Created {viewing.createdAt}</p>
              {viewing.declineReason && (
                <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  Declined: {viewing.declineReason}
                </p>
              )}

              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Item</th>
                      <th className="px-3 py-2 text-right font-medium">Qty</th>
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewing.items.map((it, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2 text-foreground">
                          <span className="block">{it.description}</span>
                          {it.colorPreference && <span className="mt-0.5 block text-[11px] text-muted-foreground">Colour preference: {it.colorPreference}</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {it.qty}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-foreground">
                          {it.priceZAR}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/30">
                      <td className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Total
                      </td>
                      <td />
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-foreground">
                        {viewing.totalZAR}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="flex flex-wrap justify-end gap-2">
                <Button asChild variant="outline" size="sm">
                  <a href={`/quotes/${viewing.id}/print`} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    Open full document
                  </a>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href={`/quotes/${viewing.id}`}>Open version page</a>
                </Button>
              </div>
            </>
          )}
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
