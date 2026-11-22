/** When a Threads token is renewed (pure, shared by lib/threads.ts and lib/threadsRenewal.ts). */
export const REFRESH_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRY_MS = 6 * 60 * 60 * 1000;

/** Does this token need a renewal attempt now? Fresh until its last 7 days; then at most every 6 hours. */
export function renewalDue(expiresAt: number, triedAt: number, now: number): "fresh" | "waiting" | "due" {
  if (!Number.isFinite(expiresAt) || expiresAt - now >= REFRESH_WITHIN_MS) return "fresh";
  return now - triedAt < RETRY_MS ? "waiting" : "due";
}
