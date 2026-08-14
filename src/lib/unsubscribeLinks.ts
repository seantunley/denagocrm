/**
 * The unsubscribe URL and its list headers — as pure string functions.
 *
 * Split out of campaigns.ts for one reason: campaigns.ts reaches `server-only`
 * through emailBrand, so nothing under `tests/` can import it and every claim
 * about these strings had to be made by matching the source text. A header whose
 * exact value is specified by an RFC deserves better than a regex over its own
 * definition — `List-Unsubscribe-Post` has to be the literal
 * `List-Unsubscribe=One-Click`, and the URI has to be angle-bracketed, and both
 * of those are facts about the output, not about the code.
 *
 * The base is a PARAMETER rather than a lookup. That is what keeps this module
 * pure, and it is safe from drift because campaigns.ts resolves the base in
 * exactly one place (`emailBase`) that both the footer link and the header go
 * through.
 */

/** Where a recipient's unsubscribe link points. `base` carries no trailing slash. */
export function unsubscribeUrlFor(base: string, token: string): string {
  return `${base}/api/unsubscribe/${token}`;
}

/**
 * `List-Unsubscribe` + `List-Unsubscribe-Post` for one recipient.
 *
 * Gmail and Yahoo require one-click unsubscribe (RFC 8058) from bulk senders and
 * we sent neither header. The absence is invisible until it is not: it is weighed
 * as a reputation signal, so the symptom is campaign mail landing in spam for
 * reasons no send log records.
 *
 * `List-Unsubscribe-Post` is what makes it ONE click rather than a link the
 * client merely surfaces — the provider POSTs this exact body itself, with no
 * cookie, no origin and no user agent of ours. That is why the route's POST
 * handler cannot require a session or a CSRF token, and why the mutation had to
 * come off the GET first: RFC 8058 needs a POST endpoint, and a GET that
 * unsubscribes is a GET that prefetchers and mail scanners trigger by walking
 * the message.
 *
 * Angle brackets are RFC 2369 and not decoration — a bare URL is ignored by some
 * providers, and a header that is present and inert is worse than one that is
 * absent, because it looks done.
 *
 * HTTPS only, no `mailto:` alternative. The spec permits both; offering a mailbox
 * we do not parse would be advertising an unsubscribe route that goes nowhere.
 */
export function unsubscribeHeadersFor(base: string, token: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${unsubscribeUrlFor(base, token)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
