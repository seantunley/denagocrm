/**
 * The pure half of the ChatGPT-subscription integration: token and stream
 * handling with no network and no database, so tests can execute it rather
 * than read it. lib/codex.ts does the I/O.
 */

/**
 * The model research runs on when a workspace has not chosen one.
 *
 * gpt-5.6-terra: OpenAI's named replacement for gpt-5.4 when it retired gpt-5.4
 * from ChatGPT-authenticated Codex on 31 August 2026. This default USED to be
 * gpt-5.4, so every fresh connection would have failed on its first call.
 *
 * Not gpt-6-sol, although OpenAI's model list now leads with it: the changelog
 * has GPT-6 Sol and Luna "rolling out" from 22 September 2026, so an account
 * that has not received them yet would be refused. Terra is the one every
 * ChatGPT-signed-in account has had since the gpt-5.4 retirement.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5.6-terra";

/**
 * What to try, in order, if the chosen model is refused.
 *
 * MODELS RETIRE ON A SCHEDULE AND A STORED CHOICE DOES NOT KNOW. A workspace
 * that picked a model, or relied on a default that later retired, would lose
 * research on the day OpenAI switched it off, with an error nobody reads until
 * the notes stop appearing. So a refusal walks down this list, and the model
 * that answers is saved.
 *
 * This table will itself age. When OpenAI publishes a new lineup, update it
 * here, most broadly available first.
 */
export const CODEX_MODEL_FALLBACKS = [
  "gpt-5.6-terra",
  "gpt-6-sol",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-6-astra",
] as const;

/**
 * Models OpenAI has announced it is withdrawing from ChatGPT-authenticated
 * Codex, and the day it happens. From that day a stored choice of one of these
 * is skipped rather than tried, so nobody pays a failed call to learn it is gone.
 * (gpt-5.4 and gpt-5.4-mini: OpenAI changelog, 31 July 2026. gpt-5.5: OpenAI
 * models page.)
 */
export const CODEX_RETIRED_MODELS: Readonly<Record<string, string>> = {
  "gpt-5.4": "2026-08-31",
  "gpt-5.4-mini": "2026-08-31",
  "gpt-5.5": "2026-10-14",
};

export function isRetiredModel(model: string, now = new Date()): boolean {
  const date = CODEX_RETIRED_MODELS[model.trim().toLowerCase()];
  return Boolean(date) && now.toISOString().slice(0, 10) >= date;
}

/**
 * The configured model first — unless it has retired — then the fallbacks,
 * without repeats. A workspace still set to gpt-5.4 therefore starts at Terra.
 */
export function modelCandidates(configured: string | null | undefined, now = new Date()): string[] {
  const chosen = configured?.trim();
  const usable = chosen && !isRetiredModel(chosen, now) ? [chosen] : [];
  return [...new Set([...usable, ...CODEX_MODEL_FALLBACKS])];
}

/**
 * Is this failure the backend refusing the MODEL — retired, unknown, or not on
 * this plan — rather than anything else?
 *
 * Only then is it worth trying another model. A usage limit (429), an outage
 * (5xx) or an expired sign-in (401) fails the same way whatever model is asked
 * for, and walking the list would just spend three calls learning that.
 */
export function isModelRejection(status: number, message: string): boolean {
  if (status === 401 || status === 429 || status >= 500) return false;
  return /model/i.test(message) && /not (found|supported|available)|unsupported|unknown|invalid|retired|does not exist|no longer|deprecated|access/i.test(message);
}

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
 * from the terminal `response.completed` event — it is the authoritative whole.
 *
 * ONLY `response.completed` MEANS FINISHED. A stream that ends WITHOUT a
 * terminal event — the connection dropped, the function timed out, the backend
 * stopped mid-answer — is marked `incomplete`, even though the deltas that did
 * arrive read like a briefing. The first version returned those deltas as
 * complete, and research saved a sentence cut off halfway as the finished note.
 * The text is still returned so the caller can log what arrived, but
 * `incomplete` is the equivalent of Anthropic's `max_tokens` stop: it must never
 * be saved as research.
 */
export function parseCodexStream(raw: string): { text: string; incomplete: boolean; failed: string | null } {
  let deltas = "";
  let completedText: string | null = null;
  let incomplete = false;
  let terminal = false;
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
        terminal = true;
        completedText = outputText(event.response);
        break;
      case "response.incomplete":
        terminal = true;
        incomplete = true;
        completedText = outputText(event.response) || null;
        break;
      case "response.failed":
        terminal = true;
        failed = errorText(event.response) ?? "response.failed";
        break;
      case "error":
        terminal = true;
        failed = errorText(event) ?? "error";
        break;
    }
  }

  return { text: (completedText ?? deltas).trim(), incomplete: incomplete || !terminal, failed };
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
