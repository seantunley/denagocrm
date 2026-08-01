/**
 * Destination safety for the campaign click tracker (`/api/track/c/[token]`).
 *
 * `buildTrackedEmail` rewrites every absolute link in a campaign into
 * `<app>/api/track/c/<token>?u=<destination>`, so the destination comes back to
 * us as a QUERY PARAMETER — a value anybody can retype, on a URL that lives on
 * the company's own domain and that recipients have been TRAINED to trust
 * because every real campaign mail looks exactly like it. Following `?u=` on
 * sight makes the CRM a redirect launderer: the perfect phishing hop, arriving
 * with the sender's reputation already attached.
 *
 * So the rule is that a destination is followed only when the APPLICATION
 * vouches for its host — the app's own origin, an operator-configured host, or
 * a host the OWNING CAMPAIGN's stored body actually links to. Everything else
 * fails closed to the app's home page. The check is not reachable at all until
 * the token has been matched to a real recipient, so an unknown token can never
 * redirect anywhere but home.
 *
 * Residual, and deliberately accepted: if a campaign links to a host that
 * serves third-party content (a URL shortener, say), that host stays reachable
 * with an attacker-chosen path. Closing that needs the destination resolved
 * per-link rather than per-host — a stored link record or a link index in the
 * path — which would invalidate every tracking URL already sitting in a
 * recipient's inbox. Host-level is the bar this fix sets.
 */

/**
 * The one pattern that decides which links become tracked links.
 *
 * Shared with `buildTrackedEmail` so the rewrite and the allowlist can never
 * drift apart: a link the rewriter did not touch can never come back as `?u=`,
 * and a link it did touch is always recoverable from the stored body. Built
 * fresh per call because a `/g` regex carries `lastIndex` between uses.
 */
export function trackedLinkPattern(): RegExp {
  return /href="(https?:\/\/[^"]+)"/g;
}

/**
 * Normalise a host for comparison, or `null` if it is not one.
 *
 * Both sides of every comparison go through `new URL`, so the WHATWG parser
 * applies the SAME lowercasing and IDNA/punycode conversion to each. That is
 * what makes `EVIL.com` and a Cyrillic-`а` homograph resolve to what they
 * really are instead of to whatever a raw string compare would have believed.
 * Accepts either a bare host (`example.com`) or a full URL.
 */
export function normalizeHost(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(absolute).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The hosts the owning campaign itself links to — the strongest thing this app
 * can vouch for, because they are precisely the links the tracking URLs were
 * generated FROM. Read out of the campaign's own stored body, never out of
 * anything on the request, and reachable only once the token has resolved to
 * that campaign: possession of a real token is what unlocks a destination.
 *
 * Read from the UNPERSONALISED body, so a link whose HOST contains a
 * `{{merge_var}}` will not match at click time and lands on home instead. Merge
 * variables in a path or query are unaffected — only the host is compared.
 */
export function campaignLinkHosts(body: string | null | undefined): string[] {
  if (!body) return [];
  const hosts: string[] = [];
  for (const [, href] of body.matchAll(trackedLinkPattern())) {
    const host = normalizeHost(href);
    if (host) hosts.push(host);
  }
  return hosts;
}

/**
 * Extra destination hosts an operator has vouched for, as a comma-separated
 * `CAMPAIGN_LINK_HOSTS`. The escape hatch for the one case a campaign body
 * cannot cover — links in a campaign whose body was edited after it went out.
 * Unset by default: the default posture is app origin plus body-derived only.
 */
export function configuredRedirectHosts(): string[] {
  return (process.env.CAMPAIGN_LINK_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

/**
 * The destination a tracked click may be sent to, or `null` when none may be —
 * in which case the caller must fall back to somewhere the app owns.
 *
 * Rejects deliberately more than a host mismatch:
 *  - anything `new URL` cannot parse as ABSOLUTE, which is what turns away
 *    `//evil.com` and `/\evil.com` — the protocol-relative and backslash forms
 *    that a "starts with a slash, so it's ours" check waves straight through;
 *  - any scheme but http/https, so `javascript:` and `data:` can never reach a
 *    `Location` header;
 *  - any URL carrying userinfo, because `https://trusted.example@evil.com`
 *    reads as the trusted host to a human and resolves to the attacker's;
 *  - any host not in `allowedHosts`, compared on the PARSED `hostname` and
 *    never as a prefix of the raw string — `https://trusted.example.evil.com`
 *    and `https://trusted.example.co/…@evil.com` both satisfy a `startsWith`.
 *
 * Hosts are compared without the port: a port cannot change who controls the
 * content served from a host.
 */
export function safeRedirectTarget(
  candidate: string | null | undefined,
  allowedHosts: Iterable<string>,
): string | null {
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const allowed = new Set<string>();
  for (const host of allowedHosts) {
    const normalized = normalizeHost(host);
    if (normalized) allowed.add(normalized);
  }
  return allowed.has(url.hostname) ? url.toString() : null;
}
