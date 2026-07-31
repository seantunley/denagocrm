import crypto from "crypto";

/**
 * Constant-time comparison of a caller-supplied secret against the expected one.
 *
 * `a === b` on a string short-circuits at the first differing byte, so the time
 * it takes to fail leaks how much of the prefix was right. Across the public
 * internet that signal is buried in jitter and rarely practical — but every
 * secret check in this codebase already used `crypto.timingSafeEqual` except
 * the Telegram webhook and the Meta/WhatsApp verify-token handshake, so the
 * cost of being consistent is one function call.
 *
 * `timingSafeEqual` throws on length mismatch, so the lengths are compared
 * first. That comparison is itself not constant-time and does leak the
 * expected length — unavoidable without padding, and a secret's length is not
 * the part worth protecting.
 *
 * Returns false when either side is null/undefined/empty, so a missing header
 * or an unconfigured secret can never authenticate: callers fail closed.
 */
export function secretEquals(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
