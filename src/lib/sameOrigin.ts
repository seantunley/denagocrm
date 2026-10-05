/**
 * Was this request sent by a page on THIS site? For a cookie-authenticated
 * route handler (a server action gets this check from Next.js; a route does
 * not). The browser's Sec-Fetch-Site is authoritative when present; otherwise
 * the Origin header's host must be the request's own host. Anything else —
 * another site, no Origin at all — is refused.
 */
export function isSameOrigin(headers: Pick<Headers, "get">): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
