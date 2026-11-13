"use client";

import { useSyncExternalStore } from "react";

/**
 * The link between the sidebar's Ask the CRM button and the DAX chat panel (AssistantBubble).
 *
 * Sean, 2026-11-13: the floating DAX button went; the sidebar button opens the same panel. The two live in
 * different parts of the page (the sidebar in AppShell, the panel beside it in the app layout), so the panel
 * registers itself here and publishes whether it is open and has an unseen scheduled answer; the button reads that
 * and asks it to toggle. No panel mounted (DAX off for this person, or a phone) → toggle says so and the button is
 * an ordinary link to /assistant.
 */
type State = { open: boolean; unread: boolean };
const CLOSED: State = { open: false, unread: false };
let state: State = CLOSED;
let toggleImpl: (() => void) | null = null;
const listeners = new Set<() => void>();

export function publishDax(next: State): void {
  if (next.open === state.open && next.unread === state.unread) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** The panel registers how it opens; the returned function unregisters it (on unmount). */
export function registerDax(toggle: () => void): () => void {
  toggleImpl = toggle;
  return () => {
    if (toggleImpl === toggle) toggleImpl = null;
    publishDax(CLOSED);
  };
}

/** Open or close the panel. False when there is no panel — let the link go to /assistant instead. */
export function toggleDax(): boolean {
  if (!toggleImpl) return false;
  toggleImpl();
  return true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDaxState(): State {
  return useSyncExternalStore(subscribe, () => state, () => CLOSED);
}
