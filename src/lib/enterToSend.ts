/**
 * Does this keypress mean "send", or "new line"?
 *
 * Enter sends by default, because that is what every messaging app does and the
 * inbox is a messaging app. Alt+Enter — and Shift+Enter, which is the convention
 * people's hands already know — inserts a line break instead.
 *
 * Pure, so the awkward cases are testable without a browser. They are the reason
 * this is not an inline `if`:
 *
 *  - IME COMPOSITION. Typing Chinese, Japanese or Korean uses Enter to accept the
 *    candidate word. Sending on that key would make the inbox unusable in those
 *    languages, and it is invisible to anyone testing in English.
 *  - Ctrl/Cmd+Enter is "send" in some apps and must not silently insert a newline
 *    here, so it is treated as send too.
 *  - When the preference is off, Enter is always a newline and nothing is sent by
 *    keyboard at all.
 */

export type EnterIntent = "send" | "newline" | "ignore";

export type EnterKey = {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** True while an input method editor is composing a character. */
  isComposing?: boolean;
};

export function enterIntent(event: EnterKey, enterSends: boolean): EnterIntent {
  if (event.key !== "Enter") return "ignore";
  // Mid-composition Enter belongs to the IME, never to us.
  if (event.isComposing) return "ignore";
  if (event.altKey || event.shiftKey) return "newline";
  if (!enterSends) return event.ctrlKey || event.metaKey ? "send" : "newline";
  return "send";
}

/** Where the preference is remembered. Per device, which is where typing habits live. */
export const ENTER_SENDS_KEY = "denago.inbox.enterSends";

/**
 * Read the stored preference, defaulting to ON.
 *
 * Anything other than an explicit "false" is on: a corrupted or absent value must
 * land on the documented default rather than quietly changing how the key behaves.
 */
export function readEnterSends(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(ENTER_SENDS_KEY) !== "false";
  } catch {
    // Storage can throw outright when cookies are blocked. The default still holds.
    return true;
  }
}

export function writeEnterSends(
  storage: Pick<Storage, "setItem"> | null | undefined,
  enterSends: boolean,
): void {
  try {
    storage?.setItem(ENTER_SENDS_KEY, enterSends ? "true" : "false");
  } catch {
    // A preference that cannot be saved is a preference that resets next visit,
    // which is survivable. Failing the keypress would not be.
  }
}
