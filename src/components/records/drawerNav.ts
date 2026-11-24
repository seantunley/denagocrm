"use client";

import { neighbour, parseRecordRef, withOpenRecord, type RecordRef } from "@/lib/records/ref";

/**
 * Opening and closing the record drawer through the URL, without a server round
 * trip: Next folds `history.pushState` into the router, so `useSearchParams` sees
 * `?open=` change while the list under the drawer — its filters, page, scroll and
 * selection — is left exactly as it was.
 *
 * Opening pushes one history entry, so Back closes the drawer. Moving to the next
 * or previous record replaces it, so Back still closes rather than walking the list.
 * Closing goes Back when this page opened the drawer, and otherwise (a shared link)
 * just drops the param.
 */

let openedHere = false;
/** The link that opened the drawer — focus goes back to it on close if the open record's own row has gone. */
let opener: HTMLElement | null = null;
/** Where the list was scrolled when the drawer opened: closing puts it back exactly there. */
let scrollY = 0;

export function openRecord(ref: RecordRef, from?: HTMLElement | null) {
  const already = new URLSearchParams(window.location.search).has("open");
  if (!already) {
    opener = from ?? null;
    scrollY = window.scrollY;
  }
  const url = `${window.location.pathname}${withOpenRecord(window.location.search, ref)}`;
  if (already) window.history.replaceState(null, "", url);
  else {
    window.history.pushState(null, "", url);
    openedHere = true;
  }
}

export function closeRecord() {
  if (openedHere) {
    openedHere = false;
    window.history.back();
  } else {
    window.history.replaceState(null, "", `${window.location.pathname}${withOpenRecord(window.location.search, null)}`);
  }
}

/**
 * Once the drawer has closed: the list back where it was, and focus on the row of
 * the record that was open (after Next, that is a different row from the one
 * clicked), else on the link that opened it.
 */
export function restoreList(lastOpen: string | null) {
  const row = lastOpen ? document.querySelector<HTMLElement>(`[data-record-open="${CSS.escape(lastOpen)}"] a, a[data-record-open="${CSS.escape(lastOpen)}"]`) : null;
  const target = row ?? (opener?.isConnected ? opener : null);
  opener = null;
  const y = scrollY;
  // After the router has settled from the Back navigation that closed the drawer.
  requestAnimationFrame(() => {
    window.scrollTo(0, y);
    target?.focus({ preventScroll: true });
  });
}

/** The records listed on this page, in the order shown — every element marked `data-record-open`. */
export function listedRecords(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-record-open]")]
    .map((el) => el.dataset.recordOpen ?? "")
    .filter((value, index, all) => parseRecordRef(value) && all.indexOf(value) === index);
}

/** The record before or after `current` in `order` (captured when it opened, so a row leaving the list doesn't lose our place). */
export function stepRecord(order: string[], current: string, step: 1 | -1): RecordRef | null {
  return parseRecordRef(neighbour(order, current, step));
}
