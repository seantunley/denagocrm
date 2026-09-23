import "server-only";

import crypto from "node:crypto";
import { basePrisma } from "./db";
import { getSetting, putSetting } from "./settings";
import { logError } from "./errorLog";
import { currentTenantScope } from "./tenantScope";
import {
  CODEX_DEFAULT_MODEL,
  accountIdFromToken,
  needsRefresh,
  parseCodexStream,
  type CodexTokens,
} from "./codexProtocol";

/**
 * A workspace's ChatGPT subscription, used for lead research instead of
 * pay-per-token API credit.
 *
 * OpenAI sanctioned signing in with a ChatGPT account in third-party agent
 * tools in May 2026 (OpenClaw first). This is the same mechanism OpenClaw uses,
 * read from its source: the Codex CLI's device-code sign-in against
 * auth.openai.com, then the Responses API on the ChatGPT backend. Usage comes
 * out of the plan's included Codex allowance instead of a per-token bill.
 *
 * ONE WORKSPACE, ONE LOGIN. Tokens live in tenant-scoped settings, so a
 * connection only ever researches the leads of the workspace that made it.
 * Using one workspace's subscription for another's customers is the version of
 * this that would clearly be misuse, and the storage layer rules it out.
 *
 * WHAT IS NOT DOCUMENTED. `chatgpt.com/backend-api/codex` is not OpenAI's public
 * API. The request shape here follows OpenClaw and the Codex CLI, but it can
 * change without notice. `testCodexConnection` exists so that a change shows up
 * as one clear error on the settings screen, not as research quietly failing.
 */

const AUTH_BASE = "https://auth.openai.com";
/** The Codex CLI's public OAuth client — the one OpenClaw also signs in with. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CALLBACK = `${AUTH_BASE}/deviceauth/callback`;
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR = "denago_crm";

/** Credential-class: encrypted at rest (SECRET_KEYS in lib/settings.ts). */
export const CODEX_TOKENS_KEY = "CODEX_OAUTH_TOKENS";
/**
 * A sign-in in progress. Also a credential: whoever holds the device id and the
 * user code can finish the sign-in and receive the tokens, for up to 15 minutes.
 */
export const CODEX_DEVICE_KEY = "CODEX_DEVICE_LOGIN";
export const CODEX_MODEL_KEY = "CODEX_MODEL";

const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { originator: ORIGINATOR, "User-Agent": ORIGINATOR, ...extra };
}

async function readTokens(): Promise<CodexTokens | null> {
  const raw = await getSetting(CODEX_TOKENS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CodexTokens;
    return parsed.access && parsed.refresh ? parsed : null;
  } catch {
    return null;
  }
}

export async function isCodexConnected(): Promise<boolean> {
  return Boolean(await readTokens());
}

export async function codexModel(): Promise<string> {
  return (await getSetting(CODEX_MODEL_KEY))?.trim() || CODEX_DEFAULT_MODEL;
}

export type CodexStatus =
  | { state: "disconnected" }
  | { state: "pending"; userCode: string; verificationUrl: string; expiresAt: number }
  | { state: "connected"; accountId: string | null; model: string };

export async function codexStatus(): Promise<CodexStatus> {
  const tokens = await readTokens();
  if (tokens) return { state: "connected", accountId: tokens.accountId, model: await codexModel() };
  const pending = await readPendingLogin();
  if (pending) {
    return {
      state: "pending",
      userCode: pending.userCode,
      verificationUrl: `${AUTH_BASE}/codex/device`,
      expiresAt: pending.startedAt + DEVICE_LOGIN_TTL_MS,
    };
  }
  return { state: "disconnected" };
}

/* ── Sign-in: device code ─────────────────────────────────────────── */

type PendingLogin = { deviceAuthId: string; userCode: string; startedAt: number };

async function readPendingLogin(): Promise<PendingLogin | null> {
  const raw = await getSetting(CODEX_DEVICE_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingLogin;
    if (!pending.deviceAuthId || Date.now() - pending.startedAt > DEVICE_LOGIN_TTL_MS) return null;
    return pending;
  } catch {
    return null;
  }
}

/**
 * Starts a sign-in and returns the code the owner types at OpenAI.
 *
 * Nothing is held open on the server: the browser polls `pollCodexLogin` every
 * few seconds. A serverless function cannot wait 15 minutes for a human, and
 * does not need to.
 */
export async function startCodexLogin(): Promise<
  { userCode: string; verificationUrl: string; intervalMs: number } | { error: string }
> {
  const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => error as Error);

  if (res instanceof Error) {
    await logError("codex-auth", res, "device code request");
    return { error: "Could not reach OpenAI to start the sign-in." };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    await logError("codex-auth", `Device code request failed (${res.status})`, text.slice(0, 300));
    return { error: `OpenAI refused to start the sign-in (${res.status}).` };
  }

  const body = safeJson(text);
  const deviceAuthId = str(body?.device_auth_id);
  const userCode = str(body?.user_code) ?? str(body?.usercode);
  if (!deviceAuthId || !userCode) {
    await logError("codex-auth", "Device code response missing fields", text.slice(0, 300));
    return { error: "OpenAI's sign-in response was not in the expected shape." };
  }

  const pending: PendingLogin = { deviceAuthId, userCode, startedAt: Date.now() };
  await putSetting(CODEX_DEVICE_KEY, JSON.stringify(pending));
  const interval = Number(body?.interval);
  return {
    userCode,
    verificationUrl: `${AUTH_BASE}/codex/device`,
    intervalMs: Number.isFinite(interval) && interval > 0 ? Math.max(1000, interval * 1000) : 5000,
  };
}

/**
 * One poll. "pending" until the owner approves at OpenAI, then exchanges the
 * approval for tokens and stores them.
 */
export async function pollCodexLogin(): Promise<
  { state: "pending" } | { state: "connected" } | { state: "expired" } | { error: string }
> {
  const pending = await readPendingLogin();
  if (!pending) return { state: "expired" };

  const res = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);

  // Not yet approved answers 403/404; a network blip is also just "try again".
  if (!res || res.status === 403 || res.status === 404) return { state: "pending" };

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    await logError("codex-auth", `Device authorization failed (${res.status})`, text.slice(0, 300));
    await putSetting(CODEX_DEVICE_KEY, "");
    return { error: `OpenAI rejected the sign-in (${res.status}). Start again.` };
  }

  const body = safeJson(text);
  const code = str(body?.authorization_code);
  const verifier = str(body?.code_verifier);
  if (!code || !verifier) {
    await logError("codex-auth", "Device authorization missing exchange code", text.slice(0, 300));
    return { error: "OpenAI's approval was not in the expected shape." };
  }

  const tokens = await postTokenForm(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_CALLBACK,
    }),
  );
  if ("error" in tokens) return { error: tokens.error };

  await basePrisma.$transaction(async (tx) => {
    await putSetting(CODEX_TOKENS_KEY, JSON.stringify(tokens.tokens), tx);
    await putSetting(CODEX_DEVICE_KEY, "", tx);
  });
  return { state: "connected" };
}

export async function disconnectCodex(): Promise<void> {
  await basePrisma.$transaction(async (tx) => {
    await putSetting(CODEX_TOKENS_KEY, "", tx);
    await putSetting(CODEX_DEVICE_KEY, "", tx);
  });
}

async function postTokenForm(
  form: URLSearchParams,
  previous?: CodexTokens,
): Promise<{ tokens: CodexTokens } | { error: string; revoked?: true }> {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => error as Error);

  if (res instanceof Error) {
    await logError("codex-auth", res, "token request");
    return { error: "Could not reach OpenAI to renew the ChatGPT sign-in." };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    await logError("codex-auth", `Token request failed (${res.status})`, text.slice(0, 300));
    // These all mean the login itself is gone and only a new sign-in fixes it.
    const revoked = /invalid_grant|refresh_token_(reused|expired|invalidated)|invalid_refresh_token/i.test(text);
    return revoked
      ? { error: "The ChatGPT sign-in has expired. Reconnect it in Settings.", revoked: true }
      : { error: `OpenAI refused the ChatGPT sign-in (${res.status}).` };
  }

  const body = safeJson(text);
  const access = str(body?.access_token);
  const refresh = str(body?.refresh_token) ?? previous?.refresh;
  const expiresIn = Number(body?.expires_in);
  if (!access || !refresh) {
    await logError("codex-auth", "Token response missing fields", text.slice(0, 120));
    return { error: "OpenAI's token response was not in the expected shape." };
  }
  return {
    tokens: {
      access,
      refresh,
      expires: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000),
      accountId:
        accountIdFromToken(str(body?.id_token)) ?? accountIdFromToken(access) ?? previous?.accountId ?? null,
    },
  };
}

/* ── A usable access token ─────────────────────────────────────────── */

/**
 * A current access token, renewing it if it is about to expire.
 *
 * RENEWAL IS SERIALISED, BECAUSE THE REFRESH TOKEN IS SINGLE-USE. OpenAI rotates
 * it on every renewal and treats presenting a spent one as a sign it was
 * stolen (`refresh_token_reused`), which revokes the login. On Vercel two
 * requests can renew at the same moment — a cron slice and somebody pressing
 * Research. Without the lock, the second presents the token the first just
 * spent, and the owner has to sign in again with no idea why.
 *
 * So the check-and-renew runs under a per-workspace advisory lock, and it
 * re-reads the tokens AFTER taking the lock: whoever waited finds the fresh
 * pair already stored and uses it instead of renewing again.
 */
async function accessToken(forceRefresh = false): Promise<{ tokens: CodexTokens } | { error: string }> {
  const current = await readTokens();
  if (!current) return { error: "ChatGPT is not connected." };
  if (!forceRefresh && !needsRefresh(current)) return { tokens: current };

  const lockKey = `codex-refresh:${currentTenantScope()?.tenantId ?? "none"}`;
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

      const latest = await readTokens();
      if (!latest) return { error: "ChatGPT is not connected." };
      // Renewed by whoever held the lock before us.
      if (latest.access !== current.access && !needsRefresh(latest)) return { tokens: latest };

      const renewed = await postTokenForm(
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: latest.refresh, client_id: CLIENT_ID }),
        latest,
      );
      if ("error" in renewed) {
        // A dead login is cleared, so the screens say "disconnected" instead
        // of every research call failing on a token that can never work again.
        if (renewed.revoked) await putSetting(CODEX_TOKENS_KEY, "", tx);
        return { error: renewed.error };
      }
      await putSetting(CODEX_TOKENS_KEY, JSON.stringify(renewed.tokens), tx);
      return { tokens: renewed.tokens };
    },
    // The token call can take a while; the default 5s interactive transaction
    // timeout would abort the renewal after OpenAI had already rotated the token.
    { timeout: 45_000, maxWait: 45_000 },
  );
}

/* ── The call ──────────────────────────────────────────────────────── */

export type CodexResult =
  | { text: string; incomplete: boolean }
  | { error: string; transient?: true };

/**
 * One Responses API turn on the ChatGPT backend, with web search available.
 *
 * The backend only streams, and requires `store: false`. The stream is read to
 * the end and folded into text by `parseCodexStream`.
 */
export async function codexRespond(input: {
  instructions: string;
  prompt: string;
  webSearch?: boolean;
}): Promise<CodexResult> {
  let auth = await accessToken();
  if ("error" in auth) return { error: auth.error };
  const model = await codexModel();

  const send = (tokens: CodexTokens) =>
    fetch(RESPONSES_URL, {
      method: "POST",
      headers: headers({
        Authorization: `Bearer ${tokens.access}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        session_id: crypto.randomUUID(),
        ...(tokens.accountId ? { "chatgpt-account-id": tokens.accountId } : {}),
      }),
      body: JSON.stringify({
        model,
        instructions: input.instructions,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.prompt }] }],
        tools: input.webSearch ? [{ type: "web_search" }] : [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(90_000),
    }).catch((error: unknown) => error as Error);

  let res = await send(auth.tokens);

  // An access token can be revoked before its stated expiry. Renew once and
  // retry; a second 401 is a real answer.
  if (!(res instanceof Error) && res.status === 401) {
    auth = await accessToken(true);
    if ("error" in auth) return { error: auth.error };
    res = await send(auth.tokens);
  }

  if (res instanceof Error) {
    await logError("codex-research", res, "responses request");
    return { error: "Could not reach ChatGPT.", transient: true };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    await logError("codex-research", `ChatGPT backend ${res.status}`, text.slice(0, 300));
    // 429 is the plan's usage limit. It lifts on its own; the sweep should stop
    // for now rather than work down the list.
    const transient = res.status === 429 || res.status >= 500;
    return transient
      ? { error: `ChatGPT is unavailable or over its usage limit (${res.status}).`, transient: true }
      : { error: `ChatGPT refused the request (${res.status}).` };
  }

  const parsed = parseCodexStream(text);
  if (parsed.failed) {
    await logError("codex-research", "ChatGPT response failed", parsed.failed.slice(0, 300));
    return { error: `ChatGPT could not answer: ${parsed.failed.slice(0, 120)}` };
  }
  return { text: parsed.text, incomplete: parsed.incomplete };
}

/**
 * The settings screen's Test button: one real call, with web search, reporting
 * exactly what came back. The endpoint is undocumented and the models on offer
 * depend on the plan, so this is how a workspace finds out it works — or why
 * not — before research depends on it.
 */
export async function testCodexConnection(): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const result = await codexRespond({
    instructions: "You are a connectivity check. Answer in one short sentence.",
    prompt:
      "Search the web for the current population of Cape Town, South Africa, and state it with its source.",
    webSearch: true,
  });
  if ("error" in result) return { ok: false, error: result.error };
  if (!result.text.trim()) return { ok: false, error: "ChatGPT answered, but with no text." };
  return { ok: true, reply: result.text.trim().slice(0, 400) };
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
