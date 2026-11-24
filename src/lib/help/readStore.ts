import { withRead } from "./paths";

/**
 * Which help guides this person has read, kept in THIS BROWSER (localStorage),
 * one list per signed-in person so a shared workshop computer does not mix two
 * people's ticks.
 *
 * In the browser, not the database, on purpose: it is a convenience — a tick on
 * a reading list — not a record anybody reports on, and it needed no migration.
 * The cost is that ticks do not follow someone to another device. Storage can
 * be unavailable (private mode, a full quota); every call here then does
 * nothing, and the paths simply show no ticks.
 */
export const readKey = (userId: string) => `denago-help-read:${userId}`;

const CHANGED = "denago-help-read-changed";

export function readRaw(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function markRead(key: string, slug: string): void {
  try {
    const next = withRead(window.localStorage.getItem(key), slug);
    if (next === null) return;
    window.localStorage.setItem(key, next);
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage is unavailable: nothing to remember, nothing to tell.
  }
}

/** For useSyncExternalStore: this tab's own changes, and another tab's. */
export function subscribeRead(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}
