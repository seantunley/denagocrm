/**
 * `next/headers` for a plain Node process.
 *
 * Only the surface the action layer actually touches is implemented, and it is
 * implemented HONESTLY: `cookies()` returns whatever session the harness is
 * currently acting as, so `getCurrentUser()` performs its real JWT verification,
 * its real `User` / `UserSession` lookups and its real tenant-scope
 * establishment. Nothing here shortcuts authentication.
 *
 * `headers()` returns an empty set. That is not a gap: the one consumer on these
 * paths is `requestContext()` in src/lib/audit.ts, which already wraps the call
 * in try/catch and degrades to `{ipAddress: null, userAgent: null}` — so an empty
 * header set produces exactly the audit row a background job produces today.
 */
import { currentActingSession } from "../actingSession";

const SESSION_COOKIE = "denago_session";

type CookieEntry = { name: string; value: string };

class HarnessCookies {
  private entries: Map<string, string>;

  constructor(entries: Map<string, string>) {
    this.entries = entries;
  }

  get(name: string): CookieEntry | undefined {
    const value = this.entries.get(name);
    return value === undefined ? undefined : { name, value };
  }

  getAll(): CookieEntry[] {
    return [...this.entries].map(([name, value]) => ({ name, value }));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * Writes are accepted and discarded. An action that refreshes a session cookie
   * (the sliding-idle rewrite in getCurrentUser) must not crash the harness, but
   * neither should it change who the harness is acting as mid-run — the acting
   * identity is owned by runAsSession().
   */
  set(): void {}
  delete(): void {}
}

export async function cookies(): Promise<HarnessCookies> {
  const session = currentActingSession();
  const entries = new Map<string, string>();
  if (session) entries.set(SESSION_COOKIE, session.cookieValue);
  return new HarnessCookies(entries);
}

export async function headers(): Promise<Headers> {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
