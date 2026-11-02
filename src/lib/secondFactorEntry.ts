/**
 * The two-step code box, and when it may send itself.
 *
 * It takes two kinds of answer, and one box used to take both. Auto-send then
 * fired on six digits, and some backup codes (8 hex characters, ABCD-EFGH)
 * START with six digits, so a pause while typing one sent half a code. Every
 * send is counted BEFORE it is checked (reserve-before-verify, actions.ts), so
 * that burned one of the few attempts someone recovering access has.
 *
 * So the box has a mode:
 *  - "code": the 6-digit authenticator or emailed code. Six digits is the
 *    whole answer here, so it sends itself at six.
 *  - "backup": a backup code. Never sends itself, however it is typed.
 *
 * Kept free of React so the rule can be tested on its own.
 */
export type CodeEntryMode = "code" | "backup";

export type CodeEntry = { mode: CodeEntryMode; value: string };

/** Send without a click: only a complete six-digit code, and never in backup mode. */
export function shouldAutoSubmit(entry: CodeEntry): boolean {
  return entry.mode === "code" && /^\d{6}$/.test(entry.value);
}

/**
 * What typing or pasting `input` into the box means.
 *
 * In "code" mode only digits (spaces dropped, so "123 456" pastes cleanly) up
 * to six stay a code: six digits is the whole answer. A letter, a hyphen or a
 * seventh digit can only be a backup code, so the box moves to "backup" mode
 * keeping what was entered, and from then on it never sends itself. Backup
 * mode never moves back on its own: only the person's own "use your
 * authenticator code" tap does, which also empties the box.
 *
 * This is why the box has no maxLength of 6: a browser cuts a paste to
 * maxLength BEFORE the page sees it, so a pasted all-digit backup code would
 * arrive as six digits and send itself. Seen whole, it lands in backup mode.
 */
export function readCodeEntry(mode: CodeEntryMode, input: string): CodeEntry {
  if (mode === "backup") return { mode, value: input };
  const compact = input.replace(/\s+/g, "");
  return /^\d{0,6}$/.test(compact) ? { mode: "code", value: compact } : { mode: "backup", value: input.trim() };
}
