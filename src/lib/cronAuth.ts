import crypto from "crypto";
import type { NextRequest } from "next/server";

/**
 * Cron routes authenticate ONLY with CRON_SECRET, via the Authorization header —
 * exactly how Vercel Cron invokes them. Deliberately NOT accepted:
 *  - the public website intake key (compromising it must not grant execution of
 *    internal maintenance jobs), and
 *  - any secret in the query string (`?key=`), which leaks into access logs,
 *    proxies and monitoring history.
 * Fails closed when CRON_SECRET is unset.
 */
export function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
