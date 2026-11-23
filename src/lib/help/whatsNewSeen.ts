import { withSeen } from "./whatsNew";

/**
 * Which "what's new" entries have been seen, kept in THIS BROWSER. It only
 * drives a dot on the help icon, so it is per device rather than per account:
 * no database change, and nothing anybody reports on. Storage that is
 * unavailable (private mode) means the dot simply stays until the tab closes.
 */
export const WHATS_NEW_SEEN_KEY = "denago-whats-new-seen";
const CHANGED = "denago-whats-new-seen-changed";

export function readSeenRaw(): string {
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function markSeen(ids: readonly string[]): void {
  try {
    const next = withSeen(window.localStorage.getItem(WHATS_NEW_SEEN_KEY), ids);
    if (next === null) return;
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, next);
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Nothing to remember it in.
  }
}

export function subscribeSeen(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}
