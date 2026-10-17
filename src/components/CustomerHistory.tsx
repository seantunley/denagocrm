"use client";

import { Fragment, useState, type ReactNode } from "react";
import { History, Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { CUSTOMER_HISTORY_PAGE, customerHistoryFilters, matchesCustomerHistoryFilter, type CustomerHistoryFilter } from "@/lib/customerHistoryFilters";

export type CustomerHistoryEntry = { id: string; type: string; day: string; content: ReactNode };

/** Only filter metadata crosses this boundary; entries and their actions are rendered on the server. */
export default function CustomerHistory({ entries, pinned, composer, context }: {
  entries: CustomerHistoryEntry[]; pinned: ReactNode[]; composer: ReactNode; context: ReactNode;
}) {
  const [filter, setFilter] = useState<CustomerHistoryFilter>("all");
  // The latest first, a page at a time: a long-standing customer's whole history in one go was a page tens of
  // thousands of pixels tall, with the next action and deals beneath all of it on a phone.
  const [shown, setShown] = useState(CUSTOMER_HISTORY_PAGE);
  const matching = entries.filter((entry) => matchesCustomerHistoryFilter(entry.type, filter));
  const visible = matching.slice(0, shown);
  const older = matching.length - visible.length;
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-5">
        {composer}
        <section id="live-timeline" className="scroll-mt-24 rounded-xl border border-border bg-card" aria-label="Customer history">
          <div className="flex items-center gap-2 px-4 pt-4"><History className="size-4 text-muted-foreground" aria-hidden="true" /><h2 className="font-semibold">Customer history</h2><span className="text-xs text-muted-foreground">{matching.length}</span></div>
          <div className="flex flex-wrap gap-1 border-b border-border p-3" role="group" aria-label="Filter customer history">
            {customerHistoryFilters.map(({ key, label }) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => { setFilter(key); setShown(CUSTOMER_HISTORY_PAGE); }} className={cn("min-h-9 rounded-md px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", filter === key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{label}</button>)}
          </div>
          <p className="sr-only" role="status">{visible.length} of {matching.length} entries shown</p>
          {visible.length === 0 ? <p className="p-6 text-sm text-muted-foreground">{filter === "all" ? "No history yet. Add a note or contact this customer to get started." : "No entries match this filter. Choose All to see the complete history."}</p> : (
            <ol className="space-y-1 p-4">
              {visible.map((entry, index) => <Fragment key={entry.id}>
                {(index === 0 || visible[index - 1].day !== entry.day) && <li className="pb-2 pt-3 text-xs font-semibold text-muted-foreground">{entry.day}</li>}
                {entry.content}
              </Fragment>)}
            </ol>
          )}
          {older > 0 && (
            <div className="border-t border-border p-3 text-center">
              <button type="button" onClick={() => setShown((n) => n + CUSTOMER_HISTORY_PAGE)} className="btn-secondary btn-sm">
                Show older ({older} more)
              </button>
            </div>
          )}
        </section>
      </div>
      {/* On a narrow screen the next action and open deals come FIRST, not below the whole history. */}
      <aside className="order-first min-w-0 space-y-4 xl:order-none" aria-label="Customer context">
        {context}
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Pin className="size-4 text-amber-400" aria-hidden="true" />Pinned for the team <span className="text-xs text-muted-foreground">{pinned.length}</span></h2>
          {pinned.length ? <ol className="space-y-3">{pinned}</ol> : <p className="text-xs leading-5 text-muted-foreground">Pin a useful note or activity from the history to keep it here.</p>}
        </section>
      </aside>
    </div>
  );
}
