// Live connection tests for outbound integrations.
//
// The point of this module is that a credential is proven against the real
// provider BEFORE it is stored, and that a failure comes back as a specific,
// actionable sentence — "the token is valid but it can't see that phone number"
// — rather than a boolean the UI has to guess at.
//
// Three rules hold everywhere in here:
//
//  1. NO SECRET IN AN OUTPUT. Every message returned from a probe is a sentence
//     WE wrote, never the provider's raw body: Meta echoes request context into
//     error payloads and SMTP servers echo the auth dialogue, so a passthrough
//     would put a token in the browser, in the audit trail and in the logs.
//     `redactSecrets` is then applied on top as defence in depth, because the
//     curated sentences do interpolate non-secret facts (host, user, number id)
//     and a provider could in principle plant a secret in one.
//  2. NO LOGGING. This module never writes to the error log or the console. It
//     returns a value; the caller decides what to persist. That keeps the one
//     place secrets flow through free of any sink that could capture them.
//  3. EVERY NETWORK DEPENDENCY IS INJECTABLE. `probeSmtp`/`probeWhatsApp` take a
//     `deps` object defaulting to the real transport — the same pattern
//     resolveTenantCredential uses — so unit tests exercise the classification
//     logic with plain closures and CI never opens a socket.

import { VERIFY_STEP_ID } from "./integrationFlow";

/** Every probe is bounded; a wedged provider must not hold a server action open. */
export const PROBE_TIMEOUT_MS = 15_000;

const GRAPH = "https://graph.facebook.com/v21.0";

export type ProbeFailureCode =
  /** Host doesn't resolve, refuses the connection, or the provider is down. */
  | "unreachable"
  /** The connection was made but TLS could not be negotiated. */
  | "tls_failed"
  /** The credential was rejected: wrong password, expired or revoked token. */
  | "auth_failed"
  /** The credential is good but doesn't refer to the account/number given. */
  | "identity_mismatch"
  /** Authenticated, but the credential lacks the scope this integration needs. */
  | "permission_denied"
  /** Provider asked us to back off. */
  | "rate_limited"
  /** The provider answered, but with something we can't attribute. */
  | "provider_error"
  /** Took too long. */
  | "timeout"
  /** We refused to even try — the values can't be a valid credential. */
  | "invalid_input";

/**
 * The failure classes that mean THE STORED CREDENTIAL IS THE PROBLEM, and so
 * should flip an integration into "reauth required".
 *
 * The exclusions matter more than the inclusions. `timeout`, `unreachable`,
 * `rate_limited` and `provider_error` are all states the credential survives —
 * marking on those would let a thirty-second provider blip lock a tenant out of
 * their own integration and demand they re-enter a password that was never
 * wrong. Only a failure the provider attributes to the credential itself earns
 * an interruption.
 */
export const REAUTH_FAILURE_CODES: ReadonlySet<ProbeFailureCode> = new Set<ProbeFailureCode>([
  "auth_failed",
  "permission_denied",
  "identity_mismatch",
]);

export function failureRequiresReauth(code: ProbeFailureCode): boolean {
  return REAUTH_FAILURE_CODES.has(code);
}

/** A non-fatal finding: the credential works, but something adjacent doesn't. */
export type ProbeWarning = { code: string; message: string };

export type ProbeSuccess = {
  ok: true;
  /** One-sentence confirmation of what we proved. Never contains a secret. */
  detail: string;
  /** Non-sensitive facts read back from the provider, shown as confirmation. */
  facts: { label: string; value: string }[];
  /** Things that are wrong but do not block saving (e.g. webhook unreachable). */
  warnings: ProbeWarning[];
};

export type ProbeFailure = {
  ok: false;
  code: ProbeFailureCode;
  /** One-sentence explanation the owner can act on. Never contains a secret. */
  message: string;
  /** The flow step that must be revisited to fix this. */
  blameStep: string;
};

export type ProbeResult = ProbeSuccess | ProbeFailure;

const REDACTED = "[redacted]";

/**
 * Removes known secret values, and anything token-shaped, from a string.
 *
 * Applied to every message a probe returns. `split`/`join` rather than a RegExp
 * so a secret containing regex metacharacters is still matched literally, and
 * longest-first so a secret that contains a shorter one is fully masked rather
 * than half-masked into a still-recognisable fragment.
 *
 * The 4-character floor stops a degenerate secret (say a one-character test
 * password, or "true" for SMTP_SECURE) from redacting ordinary prose into
 * uselessness — such a value carries no meaningful entropy to protect anyway.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = String(text ?? "");

  const known = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.trim().length >= 4))]
    .sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join(REDACTED);

  // Defence in depth for secrets we were not told about — a provider quoting our
  // own Authorization header back, or a connection URI with inline credentials.
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, `$1 ${REDACTED}`);
  out = out.replace(
    /\b(access_token|auth_token|api_key|apikey|client_secret|password|passwd|pwd|token|secret)\b(\s*[=:]\s*"?)([^\s"&,;)]{4,})/gi,
    `$1$2${REDACTED}`,
  );
  // scheme://user:secret@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]{4,}@/gi, `$1:${REDACTED}@`);

  return out;
}

function fail(code: ProbeFailureCode, message: string, blameStep: string, secrets: readonly (string | null | undefined)[] = []): ProbeFailure {
  return { ok: false, code, message: redactSecrets(message, secrets), blameStep };
}

function succeed(
  detail: string,
  facts: { label: string; value: string }[],
  warnings: ProbeWarning[],
  secrets: readonly (string | null | undefined)[] = [],
): ProbeSuccess {
  return {
    ok: true,
    detail: redactSecrets(detail, secrets),
    facts: facts.map((f) => ({ label: f.label, value: redactSecrets(f.value, secrets) })),
    warnings: warnings.map((w) => ({ code: w.code, message: redactSecrets(w.message, secrets) })),
  };
}

// ── SMTP ────────────────────────────────────────────────────────────────────

export type SmtpProbeInput = {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
};

/** Opens a real SMTP session and authenticates. Resolves on success, rejects otherwise. */
export type SmtpVerifier = (input: SmtpProbeInput) => Promise<void>;

/**
 * nodemailer's `verify()` performs the full connect → EHLO → STARTTLS → AUTH
 * handshake, so a pass means the credentials genuinely work — not merely that
 * the port is open.
 *
 * Note the explicit timeouts: src/lib/email.ts's send transport sets none, and
 * an unresponsive mail server would otherwise hang this probe (and the server
 * action behind it) far past any sensible request budget.
 */
const defaultSmtpVerifier: SmtpVerifier = async (input) => {
  const nodemailer = (await import("nodemailer")).default;
  const transporter = nodemailer.createTransport({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: input.user ? { user: input.user, pass: input.pass ?? "" } : undefined,
    connectionTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout: PROBE_TIMEOUT_MS,
    socketTimeout: PROBE_TIMEOUT_MS,
  });
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
};

type ErrorShape = { code?: unknown; responseCode?: unknown; message?: unknown; command?: unknown };

/**
 * Maps a nodemailer/Node socket error onto a specific cause and the flow step
 * that can fix it.
 *
 * Split out from `probeSmtp` and exported so the mapping table itself is
 * unit-testable against synthetic errors, with no transport involved at all.
 */
export function classifySmtpError(err: unknown, input: SmtpProbeInput): ProbeFailure {
  const e = (err ?? {}) as ErrorShape;
  const code = typeof e.code === "string" ? e.code : "";
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : 0;
  const raw = typeof e.message === "string" ? e.message : "";
  const secrets = [input.pass];
  const where = `${input.host}:${input.port}`;

  // Authentication rejected — 535/534/538 are the SMTP auth-failure family.
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || responseCode === 538) {
    return fail(
      "auth_failed",
      `${where} accepted the connection but rejected the username and password. If this mailbox has two-factor authentication, it will need an app-specific password rather than the account password.`,
      "credentials",
      secrets,
    );
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return fail("unreachable", `The hostname ${input.host} doesn't resolve. Check it for a typo.`, "server", secrets);
  }
  if (code === "ECONNREFUSED") {
    return fail(
      "unreachable",
      `${input.host} refused the connection on port ${input.port}. The host is reachable, so the port is probably wrong — 587 is the usual submission port, 465 for implicit TLS.`,
      "server",
      secrets,
    );
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || /timed?\s*out/i.test(raw)) {
    return fail(
      "timeout",
      `${where} didn't respond in time. That usually means a firewall is dropping traffic to that port rather than refusing it.`,
      "server",
      secrets,
    );
  }
  // TLS: nodemailer surfaces these as ESOCKET, plus Node's own cert error codes.
  if (
    code === "ESOCKET" ||
    code.startsWith("ERR_TLS") ||
    /self[- ]signed|certificate|wrong version number|ssl|tls/i.test(raw)
  ) {
    return fail(
      "tls_failed",
      `Connected to ${where}, but the encrypted handshake failed. This is nearly always the encryption setting not matching the port: use port 465 with encryption on, or port 587 with it off (the server then upgrades the connection itself).`,
      "server",
      secrets,
    );
  }
  if (code === "EENVELOPE" || responseCode === 550 || responseCode === 553) {
    return fail(
      "identity_mismatch",
      `${where} signed in successfully but refused the From address. Most servers only allow sending as an address the mailbox actually owns.`,
      "identity",
      secrets,
    );
  }

  // Unattributable: report the class, never the server's raw text — an SMTP
  // rejection can quote the AUTH line back at us.
  return fail(
    "provider_error",
    `${where} refused the connection for a reason we couldn't identify${responseCode ? ` (SMTP code ${responseCode})` : ""}. Check the server's own logs for this attempt.`,
    VERIFY_STEP_ID,
    secrets,
  );
}

/**
 * Live SMTP test: connects, negotiates TLS and authenticates.
 *
 * Deliberately does NOT send a message — a setup wizard should not put mail in
 * someone's inbox, and `verify()` already proves everything a send would except
 * the recipient. The "send a test email" button on the email settings page
 * remains the way to prove delivery end to end.
 */
export async function probeSmtp(
  input: SmtpProbeInput,
  deps: { verify?: SmtpVerifier } = {},
): Promise<ProbeResult> {
  const verify = deps.verify ?? defaultSmtpVerifier;
  try {
    await verify(input);
  } catch (err) {
    return classifySmtpError(err, input);
  }
  const how = input.secure ? "an encrypted connection" : "a connection";
  return succeed(
    input.user
      ? `Opened ${how} to ${input.host}:${input.port} and signed in as ${input.user}.`
      : `Opened ${how} to ${input.host}:${input.port}; the server accepts mail without signing in.`,
    [
      { label: "Server", value: `${input.host}:${input.port}` },
      { label: "Encryption", value: input.secure ? "On (implicit TLS)" : "Negotiated (STARTTLS)" },
      { label: "Sends as", value: input.from },
    ],
    [],
    [input.pass],
  );
}

// ── WhatsApp Cloud API ──────────────────────────────────────────────────────

export type WhatsAppProbeInput = { phoneNumberId: string; accessToken: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Result of checking that Meta can actually deliver inbound events to us. */
export type WebhookCheck = { reachable: boolean; detail: string };

/**
 * Confirms our own WhatsApp webhook endpoint is live.
 *
 * Deliberately sends a DELIBERATELY WRONG verify token: the route answers 403
 * "Verification failed" for a bad token and 200 only for the real one, so a 403
 * is positive proof that the endpoint exists and is executing — without this
 * probe needing to know, or handle, the real META_VERIFY_TOKEN. Any HTTP answer
 * means reachable; only a transport error or a 404/5xx means it is not.
 */
async function defaultWebhookCheck(baseUrl: string, deps: { fetch?: FetchLike }): Promise<WebhookCheck> {
  const doFetch = deps.fetch ?? fetch;
  const url = `${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=connection-test&hub.challenge=connection-test`;
  try {
    const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status === 404) return { reachable: false, detail: "the webhook route returned 404 Not Found" };
    if (res.status >= 500) return { reachable: false, detail: `the webhook route returned ${res.status}` };
    return { reachable: true, detail: `the webhook route answered ${res.status}` };
  } catch {
    return { reachable: false, detail: "the request to it did not complete" };
  }
}

type GraphError = { message?: unknown; code?: unknown; type?: unknown; error_subcode?: unknown };

/**
 * Maps a Graph API error response onto a specific cause.
 *
 * Meta's HTTP status is a poor signal on its own (a bad token and an unknown
 * object both commonly arrive as 400), so this leans on `error.code`, which is
 * stable and documented. Exported for direct unit testing.
 */
export function classifyGraphError(
  status: number,
  body: unknown,
  input: WhatsAppProbeInput,
): ProbeFailure {
  const err = ((body as { error?: GraphError } | null)?.error ?? {}) as GraphError;
  const code = typeof err.code === "number" ? err.code : 0;
  const subcode = typeof err.error_subcode === "number" ? err.error_subcode : 0;
  const secrets = [input.accessToken];

  // 190 is the whole OAuth-token failure family; subcode 463 is specifically
  // "expired", which is worth calling out because the fix differs.
  if (code === 190 || status === 401) {
    return fail(
      "auth_failed",
      subcode === 463
        ? "Meta says this access token has expired. Temporary tokens from the API Setup page last 24 hours — generate a permanent System User token instead."
        : "Meta rejected this access token. It has been revoked, regenerated, or was copied incompletely.",
      "credentials",
      secrets,
    );
  }
  // 10 and the 200-299 band are permission errors: the token is real but thin.
  if (code === 10 || (code >= 200 && code <= 299) || status === 403) {
    return fail(
      "permission_denied",
      "This access token is valid, but it doesn't carry the whatsapp_business_messaging permission. Add that permission to the System User and generate the token again.",
      "credentials",
      secrets,
    );
  }
  // 100 = unknown/inaccessible node: the token works, the id doesn't.
  if (code === 100 || status === 404) {
    return fail(
      "identity_mismatch",
      `The access token works, but Meta can't show it phone number ID ${input.phoneNumberId}. Either the ID has a typo, or it belongs to a WhatsApp account this token's System User hasn't been given access to.`,
      "identity",
      secrets,
    );
  }
  if (code === 4 || code === 80007 || code === 613 || status === 429) {
    return fail("rate_limited", "Meta is rate-limiting this app right now. Wait a minute and test again.", VERIFY_STEP_ID, secrets);
  }
  if (status >= 500) {
    return fail("unreachable", `Meta's API returned a server error (${status}). This is on their side — try again shortly.`, VERIFY_STEP_ID, secrets);
  }
  // Never pass err.message through: it can quote request context back at us.
  return fail(
    "provider_error",
    `Meta refused the request with an error we don't recognise (HTTP ${status}${code ? `, code ${code}` : ""}).`,
    VERIFY_STEP_ID,
    secrets,
  );
}

/**
 * Live WhatsApp Cloud API test, in two stages so the two credential fields are
 * independently falsifiable:
 *
 *  1. Read the phone number back through Graph with this token. Passing proves
 *     the token is live AND that it can see this specific number — so a failure
 *     can name whether the token or the ID is at fault.
 *  2. Check our own webhook endpoint answers. This cannot fail the test: the
 *     token is proven, so sending will work; only RECEIVING is broken. It comes
 *     back as a warning that says exactly that.
 */
export async function probeWhatsApp(
  input: WhatsAppProbeInput,
  deps: {
    fetch?: FetchLike;
    baseUrl?: string;
    checkWebhook?: () => Promise<WebhookCheck>;
  } = {},
): Promise<ProbeResult> {
  const doFetch = deps.fetch ?? fetch;
  const secrets = [input.accessToken];

  let res: Response;
  try {
    res = await doFetch(
      `${GRAPH}/${encodeURIComponent(input.phoneNumberId)}?fields=verified_name,display_phone_number,quality_rating`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === "TimeoutError";
    return fail(
      timedOut ? "timeout" : "unreachable",
      timedOut
        ? "Meta's API didn't respond within 15 seconds. Try again; if it persists, check Meta's platform status."
        : "Couldn't reach Meta's API at all. This server may have no outbound internet access, or Meta is unreachable from it.",
      VERIFY_STEP_ID,
      secrets,
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) return classifyGraphError(res.status, body, input);

  const info = (body ?? {}) as { verified_name?: unknown; display_phone_number?: unknown; quality_rating?: unknown };
  const verifiedName = typeof info.verified_name === "string" ? info.verified_name : null;
  const displayNumber = typeof info.display_phone_number === "string" ? info.display_phone_number : null;
  const quality = typeof info.quality_rating === "string" ? info.quality_rating : null;

  const webhook = deps.checkWebhook
    ? await deps.checkWebhook()
    : await defaultWebhookCheck(deps.baseUrl ?? appBaseUrlForProbe(), { fetch: deps.fetch });

  const warnings: ProbeWarning[] = [];
  if (!webhook.reachable) {
    warnings.push({
      code: "webhook_unreachable",
      message:
        `The access token is valid and Meta recognises this number, but your webhook endpoint is unreachable — ${webhook.detail}. ` +
        `Outbound messages will send; incoming customer replies will not arrive until the endpoint is reachable and subscribed in Meta → WhatsApp → Configuration.`,
    });
  }

  const facts: { label: string; value: string }[] = [];
  if (displayNumber) facts.push({ label: "Number", value: displayNumber });
  if (verifiedName) facts.push({ label: "Verified name", value: verifiedName });
  if (quality) facts.push({ label: "Quality rating", value: quality });
  facts.push({ label: "Phone number ID", value: input.phoneNumberId });

  return succeed(
    verifiedName
      ? `Meta accepted this token and identified the number as "${verifiedName}".`
      : "Meta accepted this token and can see this phone number.",
    facts,
    warnings,
    secrets,
  );
}

/** Same resolution the rest of the app uses for its own public URL. */
function appBaseUrlForProbe(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Runs the right probe for an integration over a raw credential bundle.
 *
 * Takes plain values rather than reading storage, because the entire point is
 * to test credentials that have NOT been persisted yet.
 */
export async function probeIntegration(
  integrationId: string,
  values: Readonly<Record<string, string>>,
  deps: { verify?: SmtpVerifier; fetch?: FetchLike; checkWebhook?: () => Promise<WebhookCheck> } = {},
): Promise<ProbeResult> {
  if (integrationId === "smtp") {
    const portRaw = (values.SMTP_PORT ?? "").trim();
    return probeSmtp(
      {
        host: (values.SMTP_HOST ?? "").trim(),
        port: portRaw ? Number.parseInt(portRaw, 10) : 587,
        secure: (values.SMTP_SECURE ?? "").trim() === "true",
        user: (values.SMTP_USER ?? "").trim() || null,
        pass: values.SMTP_PASS ?? null,
        from: (values.SMTP_FROM ?? "").trim(),
      },
      deps,
    );
  }
  if (integrationId === "whatsapp") {
    return probeWhatsApp(
      {
        phoneNumberId: (values.WA_PHONE_NUMBER_ID ?? "").trim(),
        accessToken: (values.WA_ACCESS_TOKEN ?? "").trim(),
      },
      deps,
    );
  }
  return fail("invalid_input", "There is no guided connection test for this integration yet.", VERIFY_STEP_ID);
}
