/**
 * Strips capability tokens out of URLs before they are persisted.
 *
 * `instrumentation.ts` files unhandled errors into `ErrorLog` with the request's
 * resource path as context — and Next.js hands that path WITH its query string
 * ("resource path, e.g. /blog?name=foo"). Several public routes carry a bearer
 * credential in the path itself, so one thrown error was enough to write a
 * WORKING signing / approval / survey / unsubscribe link into a table that
 * Settings → System Log renders to any workspace owner, and the platform console
 * renders to any platform admin. Redaction happens at the persistence boundary
 * (here + `logError`), not at each call site, so a new logger can't reopen it.
 *
 * Deliberately pure and dependency-free: no server imports, unit-testable.
 */

/**
 * Route prefixes whose NEXT path segment is a credential, not an identifier.
 * Enumerated from the route tree (`src/app/**`), not guessed:
 *
 *   signing        /signing/:token            SignatureRecipient.token
 *   api/signing    /api/signing/:token[/decline]
 *   approvals      /approvals/:token          ApprovalStep.token
 *   api/approvals  /api/approvals/:token
 *   s              /s/:token                  SurveyResponse.token
 *   api/track/o    /api/track/o/:token        CampaignRecipient.token (open pixel)
 *   api/track/c    /api/track/c/:token        CampaignRecipient.token (click)
 *   api/unsubscribe/api/unsubscribe/:token    CampaignRecipient.token
 */
const TOKEN_PATH_PREFIXES = [
  "signing",
  "api/signing",
  "approvals",
  "api/approvals",
  "s",
  "api/track/o",
  "api/track/c",
  "api/unsubscribe",
] as const;

/**
 * Prefixes under which EVERYTHING that follows is redacted, because the token is
 * not the next segment.
 *
 * The retired signing scheme is `/sign/:kind/:token` — `quote` or `jobcard`
 * first, the credential second. Listing it above alongside the one-segment
 * routes would have redacted `quote` and left the token in the log: worse than
 * not redacting at all, because the line then LOOKS safe. No route serves these
 * today (there is no src/app/sign directory, so they 404), but `/sign` and
 * `/api/sign` are still public in proxy.ts and Quote.signToken / JobCard.signToken
 * still exist, so a link in old mail can still arrive and 404 loudly.
 *
 * Losing the `quote`/`jobcard` distinction from a log line for a route that does
 * not exist costs nothing.
 */
const TOKEN_TAIL_PREFIXES = ["sign", "api/sign"] as const;

/**
 * Query parameters whose VALUE is a secret. `hub.verify_token` is the only one a
 * route reads today (the Meta/WhatsApp webhook handshake compares it against
 * META_VERIFY_TOKEN); the rest are the conventional names, denied up front so
 * adding `?token=` to a route later cannot silently start logging it.
 *
 * `u` on /api/track/c is NOT here: it is the campaign's redirect destination,
 * not a credential, and it is the single most useful field when debugging a
 * broken tracked link.
 */
const SECRET_QUERY_PARAMS = [
  "hub.verify_token",
  "hub.challenge",
  "token",
  "t",
  "k",
  "key",
  "apikey",
  "api_key",
  "access_token",
  "auth",
  "secret",
  "sig",
  "signature",
  "hmac",
  "code",
  "otp",
  "password",
  "pass",
  "pwd",
] as const;

export const REDACTED = "[redacted]";

const escape = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a URL path may begin: start of string, after whitespace, after an
 * opening quote/bracket, or straight after the authority of an absolute URL.
 * Anchoring to this is what stops a prefix matching MID-path — without it
 * `/signatures/<id>/sign/<recipientId>` (an ordinary session-gated staff page
 * whose last segment is a plain cuid) gets redacted by the legacy `/sign/` rule.
 */
const PATH_START = `(^|[\\s"'\`(\\[]|https?://[^/\\s"'\`]+)`;

// `<path-start>/<prefix>/<segment>` → the segment is a credential. The `/` inside
// the group is what keeps a prefix from matching the head of a longer route name.
// A segment ends at the next `/`, `?`, `#`, quote or whitespace, so this works on
// a bare path, a full URL, and a URL quoted inside an error message alike.
const TOKEN_PATH_RE = new RegExp(
  `${PATH_START}(/(?:${TOKEN_PATH_PREFIXES.map(escape).join("|")})/)[^/?#\\s"'\`)\\]]+`,
  "gi",
);

// `<path-start>/<prefix>/<everything up to ? # quote or whitespace>` — used where
// the credential is not the first segment, so nothing after the prefix survives.
const TOKEN_TAIL_RE = new RegExp(
  `${PATH_START}(/(?:${TOKEN_TAIL_PREFIXES.map(escape).join("|")})/)[^?#\\s"'\`)\\]]+`,
  "gi",
);

// `?name=value` / `&name=value`. The value ends at the next `&`, `#`, quote or
// whitespace. Matched case-insensitively because query keys are not normalised.
const SECRET_QUERY_RE = new RegExp(
  `([?&](?:${SECRET_QUERY_PARAMS.map(escape).join("|")})=)[^&#\\s"'\`]*`,
  "gi",
);

/**
 * Replaces every capability token in `input` with `[redacted]`, leaving the
 * route shape intact so the log line is still diagnosable
 * (`GET /signing/[redacted]` tells you exactly which route failed).
 *
 * Accepts any string — a bare path with query, an absolute URL, or prose that
 * merely contains one — so the same function serves the instrumentation hook and
 * the error message/stack sweep in `logError`.
 */
export function redactUrl(input: string): string {
  return input
    .replace(TOKEN_PATH_RE, `$1$2${REDACTED}`)
    .replace(TOKEN_TAIL_RE, `$1$2${REDACTED}`)
    .replace(SECRET_QUERY_RE, `$1${REDACTED}`);
}
