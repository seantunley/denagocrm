/**
 * Keyboard navigation for lists and the board — the DECISIONS (no DOM; tested).
 * The DOM half is `components/ListKeyboard.tsx`, mounted once in the signed-in
 * layout, the same split as the right-click menu (appContextMenu.ts).
 *
 * A row opts in with `data-nav-row`, says where Enter goes with `data-nav-href`,
 * and — for a deal — names its lead with `data-nav-lead`, which is what e / w / a
 * act on. A board column opts in with `data-nav-stage` for 1–5.
 */

export type ListKeyAction =
  | { kind: "move"; by: 1 | -1 }
  | { kind: "open" }
  | { kind: "email" }
  | { kind: "whatsapp" }
  | { kind: "activity" }
  | { kind: "stage"; index: number }
  | { kind: "help" };

export type KeyInput = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** Focus is in something you type into: the key is the person's text, never a shortcut. */
  typing: boolean;
  /** A dialog or menu is open: its own keys win. */
  overlayOpen: boolean;
  /** Focus is ON a navigable row (Enter, e, w and a act only on the row you're on). */
  onRow: boolean;
};

/** What a key press means here — or null, and the browser keeps it. */
export function listKeyAction(input: KeyInput): ListKeyAction | null {
  // ⌘K, ⌃R, ⌥… belong to the browser and the palette; Shift only for "?".
  if (input.metaKey || input.ctrlKey || input.altKey) return null;
  if (input.typing || input.overlayOpen) return null;
  // Letters, not arrows: arrows scroll the page and move a card being dragged by keyboard.
  switch (input.key) {
    case "j":
      return { kind: "move", by: 1 };
    case "k":
      return { kind: "move", by: -1 };
    case "?":
      return { kind: "help" };
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return { kind: "stage", index: Number(input.key) - 1 };
  }
  if (!input.onRow) return null;
  switch (input.key) {
    case "Enter":
      return { kind: "open" };
    case "e":
      return { kind: "email" };
    case "w":
      return { kind: "whatsapp" };
    case "a":
      return { kind: "activity" };
  }
  return null;
}

/** The next row: j from nowhere starts at the top, k from nowhere at the bottom; never past either end. */
export function stepIndex(current: number, count: number, by: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return by === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + by));
}

/** Where e / w / a / Enter take you from a row — or null when the row can't do it (not a deal). */
export function rowDestination(action: ListKeyAction, row: { href?: string | null; lead?: string | null }): string | null {
  if (action.kind === "open") return row.href || null;
  if (!row.lead) return null;
  const lead = `/leads/${encodeURIComponent(row.lead)}`;
  if (action.kind === "email") return `${lead}?compose=email`;
  if (action.kind === "whatsapp") return `${lead}?compose=whatsapp`;
  if (action.kind === "activity") return `${lead}?tab=activities&schedule=1`;
  return null;
}

/** The cheat sheet (`?`). Kept here so what it says and what the keys do can't drift apart. */
export const SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: ["⌘K", "Ctrl K"], does: "Search and jump anywhere" },
  { keys: ["N"], does: "Quick actions — new lead, contact, quote…" },
  { keys: ["J", "K"], does: "Next / previous card or row" },
  { keys: ["Enter"], does: "Open it" },
  { keys: ["E"], does: "Email the customer (opens the deal with the email ready)" },
  { keys: ["W"], does: "WhatsApp the customer" },
  { keys: ["A"], does: "Add an activity" },
  { keys: ["1", "–", "5"], does: "Jump to that stage on the board" },
  { keys: ["?"], does: "This list" },
];
