/**
 * The pure half of the ChatGPT-subscription integration: token and stream
 * handling with no network and no database, so tests can execute it rather
 * than read it. lib/codex.ts does the I/O.
 */

/**
 * The model research runs on when a workspace has not chosen one. GPT-5.4 is the
 * model OpenAI named when it opened ChatGPT sign-in to third-party agents; which
 * models a given plan actually exposes varies, so this is a setting, and the
 * Test button on the settings screen shows immediately if it is not available.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5.4";

export type CodexTokens = {
  access: string;
  refresh: string;
  /** Epoch ms. */
  expires: number;
  /** Sent as `chatgpt-account-id`; routes the request to the right ChatGPT account. */
  accountId: string | null;
};

/** Renew this long before stated expiry, so a token cannot lapse mid-request. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function needsRefresh(tokens: Pick<CodexTokens, "expires">, now = Date.now()): boolean {
  return !Number.isFinite(tokens.expires) || tokens.expires - now < REFRESH_MARGIN_MS;
}

/**
 * After waiting for the renewal lock: did whoever held it already renew?
 *
 * The refresh token is single-use. A request that waited while another renewed
 * holds a now-spent refresh token in memory; presenting it would look like
 * theft to OpenAI and revoke the login. If the stored pair has changed since
 * this request first read it, and is fresh, use it instead of renewing again.
 */
export function renewedByAnotherHolder(
  stored: Pick<CodexTokens, "access" | "expires">,
  seenBefore: Pick<CodexTokens, "access">,
  now = Date.now(),
): boolean {
  return stored.access !== seenBefore.access && !needsRefresh(stored, now);
}

/**
 * The ChatGPT account id carried inside an OpenAI token.
 *
 * The id and access tokens are JWTs with an `https://api.openai.com/auth`
 * claim holding `chatgpt_account_id`. The token is only DECODED here, never
 * verified: it came straight from auth.openai.com over TLS, and the value is
 * only used to address our own request back to OpenAI.
 */
export function accountIdFromToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = json["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Folds a Responses API event stream into the answer text.
 *
 * The backend streams whether or not you want it to. The finished text is taken
 * from the terminal `response.completed` event when there is one — it is the
 * authoritative whole — and otherwise from the accumulated
 * `response.output_text.delta` events, so a stream cut short still yields what
 * was written.
 *
 * `incomplete` is the equivalent of Anthropic's `max_tokens` stop: text exists
 * but it was cut off, and must not be saved as a finished briefing.
 */
export function parseCodexStream(raw: string): { text: string; incomplete: boolean; failed: string | null } {
  let deltas = "";
  let completedText: string | null = null;
  let incomplete = false;
  let failed: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") deltas += event.delta;
        break;
      case "response.completed":
        completedText = outputText(event.response);
        break;
      case "response.incomplete":
        incomplete = true;
        completedText = outputText(event.response) || null;
        break;
      case "response.failed":
        failed = errorText(event.response) ?? "response.failed";
        break;
      case "error":
        failed = errorText(event) ?? "error";
        break;
    }
  }

  return { text: (completedText ?? deltas).trim(), incomplete, failed };
}

function outputText(response: unknown): string {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return "";
  // Joined with "", as the Anthropic path does: cited prose arrives split at
  // every citation boundary, and a newline between the pieces shreds a
  // sentence into lines and breaks the Company/Role/Fit card.
  return output
    .filter((item: { type?: string }) => item?.type === "message")
    .flatMap((item: { content?: unknown }) => (Array.isArray(item.content) ? item.content : []))
    .filter((part: { type?: string }) => part?.type === "output_text")
    .map((part: { text?: string }) => part.text ?? "")
    .join("");
}

function errorText(source: unknown): string | null {
  const error = (source as { error?: { message?: unknown } })?.error;
  const message = error?.message ?? (source as { message?: unknown })?.message;
  return typeof message === "string" && message ? message : null;
}
