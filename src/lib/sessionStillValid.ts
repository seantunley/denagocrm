import { ABSOLUTE_SESSION_HOURS, PWA_SESSION_HOURS } from "./session";

/** How often getCurrentUser writes UserSession.lastActiveAt (auth.ts). */
const LAST_ACTIVE_WRITE_MINUTES = 10;

export type SessionRow = {
  platform: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  revokedAt: Date | null;
  /** The account's sessionVersion when this sign-in was made; null for rows made before it was recorded. */
  sessionVersion: number | null;
};

export type AccountState = { sessionVersion: number; disabledAt: Date | null } | null;

/**
 * Whether a sign-in can still be used, by the same rules sign-in checking applies (session.ts + auth.ts):
 * not revoked, account not disabled, account's session version unchanged since, inside the token's fixed
 * lifetime (72h, or 7 days for the mobile app), and not timed out for inactivity.
 *
 * A session row is never marked ended when any of those happen, so the row alone can't say.
 * lastActiveAt is written at most every 10 minutes, so a sign-in can still be listed for up to 10 minutes
 * after it timed out — never the other way round.
 */
export function sessionStillValid(
  s: SessionRow,
  account: AccountState,
  idleMinutes: number,
  now: number = Date.now(),
): boolean {
  if (s.revokedAt || !account || account.disabledAt) return false;
  if (s.sessionVersion !== null && s.sessionVersion !== account.sessionVersion) return false;
  const pwa = s.platform === "pwa";
  const lifetimeMs = (pwa ? PWA_SESSION_HOURS : ABSOLUTE_SESSION_HOURS) * 3600_000;
  if (now - s.createdAt.getTime() >= lifetimeMs) return false;
  // The mobile app's idle timeout is a week too (createSessionCookie).
  const idleMs = ((pwa ? 7 * 24 * 60 : idleMinutes) + LAST_ACTIVE_WRITE_MINUTES) * 60_000;
  return now - s.lastActiveAt.getTime() < idleMs;
}
