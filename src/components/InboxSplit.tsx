"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { isEditableTarget } from "@/lib/appContextMenu";
import { cn } from "@/lib/utils";

export type InboxSplitItem = {
  key: string;
  unread: boolean;
  /** Bound markThreadRead — run once when an unread conversation is opened. */
  markRead?: () => Promise<unknown>;
  row: ReactNode;
  pane: ReactNode;
  /** The linked deal, beside the conversation. Absent → no third column. */
  rail?: ReactNode;
};

/**
 * The inbox as a working screen: the list stays in view while you read and reply, and
 * the deal sits beside the conversation. Every pane is rendered on the server (as the
 * modals were); this only chooses which one shows. On a phone the list and the
 * conversation take turns, with Back.
 *
 * r = reply (focus the reply box), e = archive — once a conversation is open, and not
 * while typing.
 */
export default function InboxSplit({ items, withRail = false }: { items: InboxSplitItem[]; withRail?: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = items.find((item) => item.key === selected) ?? null;
  const pane = useRef<HTMLElement>(null);

  function open(item: InboxSplitItem) {
    setSelected(item.key);
    if (item.unread && item.markRead) void item.markRead().catch(() => {});
  }

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (isEditableTarget(target) || target.tagName === "INPUT")) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (event.key === "r") {
        const reply = pane.current?.querySelector<HTMLTextAreaElement>('textarea[name="text"]:not([disabled])');
        if (!reply) return;
        event.preventDefault();
        reply.focus();
      } else if (event.key === "e") {
        const archive = pane.current?.querySelector<HTMLFormElement>("[data-inbox-archive] form");
        if (!archive) return;
        event.preventDefault();
        archive.requestSubmit();
        setSelected(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [current]);

  return (
    <div className={cn(
      "grid overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:min-h-[32rem]",
      withRail ? "lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)_18rem]" : "lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]",
    )}>
      <ul className={cn("divide-y divide-border lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:border-r lg:border-border", current && "hidden lg:block")} aria-label="Conversations">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => open(item)}
              aria-current={item.key === selected ? "true" : undefined}
              className="w-full px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary aria-[current=true]:bg-primary/10"
            >
              {item.row}
            </button>
          </li>
        ))}
      </ul>

      <section ref={pane} className={cn("min-w-0 p-4", !current && "hidden lg:block")} aria-label="Conversation">
        {current ? (
          <>
            <button type="button" onClick={() => setSelected(null)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground lg:hidden">
              <ArrowLeft className="size-4" />All conversations
            </button>
            {current.pane}
          </>
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
            <div><MessagesSquare className="mx-auto mb-2 size-6" />Choose a conversation to read and reply.<p className="mt-1 text-xs">Then <kbd className="rounded border border-border px-1">R</kbd> to reply, <kbd className="rounded border border-border px-1">E</kbd> to archive.</p></div>
          </div>
        )}
      </section>

      {withRail && current?.rail ? (
        // Beside the conversation on a wide screen; under it (same column) on a narrower one.
        <aside className="min-w-0 border-t border-border p-4 lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:border-l xl:border-t-0" aria-label="The deal">{current.rail}</aside>
      ) : withRail ? <aside className="hidden xl:block xl:border-l xl:border-border" /> : null}
    </div>
  );
}
