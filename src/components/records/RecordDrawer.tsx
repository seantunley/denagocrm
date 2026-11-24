"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { peekRecord, type PeekResult } from "@/app/actions/recordPeek";
import { fullRecordHref, formatRecordRef, OPEN_PARAM, parseRecordRef } from "@/lib/records/ref";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import LeadPeekView from "./LeadPeekView";
import { closeRecord, listedRecords, openRecord, restoreList, stepRecord } from "./drawerNav";

/**
 * The contextual record drawer (wave 2, W2-01): the record a row points at, beside
 * the list, with what can be done about it. Rendered once per page; opened by
 * `?open=<type>:<id>` (OpenRecordLink), so a list keeps its state and a link to an
 * open record can be shared.
 *
 * Detail is loaded on demand, one record at a time, by `peekRecord`, which checks
 * the workspace and the person's access every time. Switching rows quickly can
 * never show the wrong record: only the answer to the LATEST request is used.
 * On a phone the drawer fills the screen.
 */
export default function RecordDrawer() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get(OPEN_PARAM);
  const ref = parseRecordRef(raw);
  const key = ref ? formatRecordRef(ref) : null;

  const [result, setResult] = useState<{ key: string; value: PeekResult } | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [reloads, setReloads] = useState(0);
  const request = useRef(0);
  /** The record open last — its row gets focus back when the drawer closes. */
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    // Every new request supersedes the last: a slow answer for an earlier row is thrown away.
    const mine = ++request.current;
    if (!key) return;
    lastKey.current = key;
    peekRecord(key)
      .then((value) => {
        if (mine !== request.current) return;
        setResult({ key, value });
        // The list's order as it stood when this record opened: Next/Previous follow it even after a done row leaves the list.
        setOrder((previous) => (previous.includes(key) ? previous : listedRecords()));
      })
      .catch(() => {
        if (mine === request.current) setResult({ key, value: { ok: false, error: "Couldn't load this record. Check your connection and try again." } });
      });
  }, [key, reloads]);

  /** After an action: re-read this record and let the page's lists recalculate from their sources. */
  const refresh = () => {
    setReloads((n) => n + 1);
    router.refresh();
  };

  const step = (direction: 1 | -1) => {
    if (!key) return;
    const next = stepRecord(order, key, direction);
    if (next) openRecord(next);
  };

  const current = result && result.key === key ? result.value : null;
  const previousRef = key ? stepRecord(order, key, -1) : null;
  const nextRef = key ? stepRecord(order, key, 1) : null;

  return (
    <Sheet open={Boolean(ref)} onOpenChange={(open) => !open && closeRecord()}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreList(lastKey.current);
        }}
      >
        <SheetHeader className="sticky top-0 z-10 border-b border-border bg-background/95 pr-12 backdrop-blur">
          <SheetTitle className="truncate">{current?.ok ? current.peek.name : ref ? "Loading…" : ""}</SheetTitle>
          <SheetDescription className="sr-only">The record beside your list, with what can be done about it here.</SheetDescription>
          <nav className="flex flex-wrap items-center gap-2" aria-label="Record">
            <button type="button" className="btn-secondary btn-sm" onClick={() => step(-1)} disabled={!previousRef} title={previousRef ? "The record before this one in your list" : "This is the first record in your list"}>
              <ChevronLeft className="size-4" />
              Previous
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => step(1)} disabled={!nextRef} title={nextRef ? "The next record in your list" : "This is the last record in your list"}>
              Next
              <ChevronRight className="size-4" />
            </button>
            {ref && (
              <a href={fullRecordHref(ref)} className="btn-secondary btn-sm ml-auto">
                Open full record
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </nav>
        </SheetHeader>

        <div className="p-4" aria-live="polite" aria-busy={!current}>
          {!current ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Loading…
            </p>
          ) : !current.ok ? (
            <p role="alert" className="text-sm text-muted-foreground">{current.error}</p>
          ) : (
            <LeadPeekView key={current.peek.id} peek={current.peek} onChanged={refresh} onNext={nextRef ? () => step(1) : null} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
