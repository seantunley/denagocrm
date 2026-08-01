/**
 * Which URLs the server is willing to POST a push notification to.
 *
 * A Web Push subscription endpoint arrives from the BROWSER and was stored
 * verbatim: `savePushSubscription` took `sub.endpoint` off a server-action
 * argument and upserted it. Anything an authenticated user could type therefore
 * became a URL the server would later request — and the requests are fired by
 * `sendPushToAll` on ordinary app events (a new ticket, a booking, an inbound
 * email), so the attacker does not even have to trigger them.
 *
 * That is server-side request forgery with a response oracle attached:
 * `sendTestPush` returns the number of endpoints that accepted, so a subscription
 * pointed at `http://127.0.0.1:5432/` or `http://169.254.169.254/…` answers
 * "is this host reachable from inside your network" one guess at a time.
 *
 * An ALLOWLIST is the right shape here, and unusually cheap: the set of Web Push
 * services is small, fixed, and operated by the browser vendors. A denylist of
 * private ranges would not be enough anyway — DNS is resolved by the HTTP client
 * AFTER any check we make, so a hostname that resolves to 127.0.0.1 defeats it
 * (classic DNS rebinding). Naming the hosts we will talk to sidesteps that
 * entirely, because the allowed names are not attacker-influenced.
 *
 * Verified before choosing this: PushSubscription is EMPTY in production, so no
 * existing device can be broken by it.
 */

/**
 * Push services, by host suffix. Sourced from the services the major browsers
 * actually use:
 *   fcm.googleapis.com                    Chrome, Edge (Chromium), Opera
 *   *.push.services.mozilla.com           Firefox
 *   *.notify.windows.com                  Edge (legacy WNS)
 *   *.push.apple.com                      Safari (macOS/iOS 16.4+)
 * The leading dot is significant: `.push.apple.com` matches
 * `web.push.apple.com` and never `notpush.apple.com`.
 */
const DEFAULT_PUSH_HOSTS = [
  "fcm.googleapis.com",
  ".push.services.mozilla.com",
  "updates.push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
] as const;

/**
 * Extra hosts an operator has vouched for, comma-separated. The escape hatch for
 * a browser using a push service not listed above — self-hosted builds and
 * regional variants do exist — so the allowlist can be corrected by
 * configuration rather than by a deploy.
 */
function configuredHosts(): string[] {
  return (process.env.PUSH_ENDPOINT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) : host === entry,
  );
}

/**
 * Whether the server may send a push notification to this endpoint.
 *
 * https only — an `http:` endpoint would also send the (encrypted) payload and
 * the VAPID authorization header over the wire in clear.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return hostAllowed(url.hostname, [...DEFAULT_PUSH_HOSTS, ...configuredHosts()]);
}

/** The allowlist as it currently stands — for diagnostics and tests. */
export function allowedPushHosts(): string[] {
  return [...DEFAULT_PUSH_HOSTS, ...configuredHosts()];
}
