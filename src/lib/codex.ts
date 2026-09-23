import "server-only";

import crypto from "node:crypto";
import { basePrisma } from "./db";
import { getSetting, putSetting, type SettingsTx } from "./settings";
import { logError } from "./errorLog";
import { currentTenantScope } from "./tenantScope";
import {
  CODEX_DEFAULT_MODEL,
  accountIdFromToken,
  isModelRejection,
  modelCandidates,
  needsRefresh,
  parseCodexStream,
  renewedByAnotherHolder,
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

/** The model the next call will try first — a retired stored choice is skipped. */
export async function codexModel(): Promise<string> {
  return modelCandidates(await getSetting(CODEX_MODEL_KEY))[0];
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
  await withCodexLock((tx) => putSetting(CODEX_DEVICE_KEY, JSON.stringify(pending), tx));
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
    await withCodexLock(async (tx) => {
      // Only clear THIS sign-in; a newer one may have been started meanwhile.
      const still = await readPendingLogin();
      if (still?.deviceAuthId === pending.deviceAuthId) await putSetting(CODEX_DEVICE_KEY, "", tx);
    });
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

  return withCodexLock(async (tx) => {
    // The exchange above took time. If the owner pressed Disconnect, or started
    // a different sign-in, meanwhile, this sign-in is no longer wanted: storing
    // it would reconnect a workspace the owner just disconnected. Revoke the
    // tokens rather than leave a live login nobody holds.
    const still = await readPendingLogin();
    if (!still || still.deviceAuthId !== pending.deviceAuthId) {
      await revokeAtOpenAi(tokens.tokens);
      return { state: "expired" as const };
    }
    await putSetting(CODEX_TOKENS_KEY, JSON.stringify(tokens.tokens), tx);
    await putSetting(CODEX_DEVICE_KEY, "", tx);
    return { state: "connected" as const };
  });
}

/**
 * Disconnect: revoke the login AT OPENAI, then forget it here.
 *
 * Clearing the stored tokens alone leaves the refresh token valid at OpenAI.
 * If a copy of it ever existed elsewhere — a leaked backup, a log line — it
 * would keep working after the owner believed they had disconnected. Upstream
 * Codex revokes on logout for exactly this reason (codex-rs
 * login/src/auth/revoke.rs), and this does the same: the refresh token, falling
 * back to the access token, at /oauth/revoke.
 *
 * Best-effort, as upstream: a failed revoke is logged and the local copy is
 * cleared anyway. Refusing to disconnect because OpenAI was unreachable would
 * leave the owner unable to remove a login they no longer trust.
 */
export async function disconnectCodex(): Promise<{ revoked: boolean }> {
  return withCodexLock(async (tx) => {
    // Read AFTER taking the lock. A renewal that was already running has
    // finished by now, so this is its new pair — the one that must be revoked —
    // not the pair it replaced.
    const tokens = await readTokens();
    const revoked = tokens ? await revokeAtOpenAi(tokens) : true;
    await putSetting(CODEX_TOKENS_KEY, "", tx);
    await putSetting(CODEX_DEVICE_KEY, "", tx);
    return { revoked };
  });
}

async function revokeAtOpenAi(tokens: CodexTokens): Promise<boolean> {
  const useRefresh = Boolean(tokens.refresh);
  const res = await fetch(`${AUTH_BASE}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: useRefresh ? tokens.refresh : tokens.access,
      token_type_hint: useRefresh ? "refresh_token" : "access_token",
      // Upstream sends the client id with a refresh token only.
      ...(useRefresh ? { client_id: CLIENT_ID } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => error as Error);

  if (res instanceof Error || !res.ok) {
    const detail = res instanceof Error ? res.message : `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
    await logError("codex-auth", "Could not revoke the ChatGPT sign-in at OpenAI; cleared locally anyway", detail);
    return false;
  }
  return true;
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

/* ── One lock for everything that changes the sign-in ──────────────── */

/**
 * Runs `fn` holding this workspace's ChatGPT sign-in lock, inside a transaction
 * whose `tx` is the only way to write the sign-in state.
 *
 * EVERY WRITE OF THE SIGN-IN GOES THROUGH HERE — renew, disconnect, connect,
 * starting or rejecting a sign-in. Each of them does network I/O between reading
 * the state and writing it, and any two of them can overlap:
 *
 * - A renewal already talking to OpenAI when the owner clicks Disconnect would
 *   write its freshly rotated pair AFTER the clear, and the workspace would be
 *   connected again with the screen saying it was not.
 * - A sign-in poll mid-exchange when the owner clicks Disconnect would do the
 *   same with a brand-new login.
 *
 * Holding one lock across all of them serialises them, and each re-reads the
 * state AFTER acquiring it, so whichever starts second sees the first one's
 * final result instead of the state from before it began.
 *
 * The timeout covers the OpenAI calls made while holding it; the default five
 * seconds would abort a renewal after OpenAI had already rotated the token.
 */
function withCodexLock<T>(fn: (tx: SettingsTx) => Promise<T>): Promise<T> {
  const lockKey = `codex-signin:${currentTenantScope()?.tenantId ?? "none"}`;
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
      return fn(tx);
    },
    { timeout: 45_000, maxWait: 45_000 },
  );
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

  return withCodexLock(async (tx) => {
    // Re-read under the lock: a Disconnect that finished first leaves nothing
    // here, and a renewal that finished first leaves a fresh pair to use.
    const latest = await readTokens();
    if (!latest) return { error: "ChatGPT is not connected." };
    if (renewedByAnotherHolder(latest, current)) return { tokens: latest };

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
  });
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
 *
 * Headers follow current upstream Codex (codex-rs core/src/client.rs):
 * `session-id` — hyphenated; ChatGPT derives Responses cache affinity from it —
 * and no `OpenAI-Beta`, which upstream sends only on its WebSocket transport.
 *
 * A model the backend refuses (retired, not on this plan, not rolled out yet)
 * is not the end of the call: the next candidate is tried, and whichever
 * answers is saved as the workspace's model.
 */
export async function codexRespond(input: {
  instructions: string;
  prompt: string;
  webSearch?: boolean;
}): Promise<CodexResult> {
  let auth = await accessToken();
  if ("error" in auth) return { error: auth.error };

  const configured = (await getSetting(CODEX_MODEL_KEY))?.trim() || null;
  const sessionId = crypto.randomUUID();

  const send = (tokens: CodexTokens, model: string) =>
    fetch(RESPONSES_URL, {
      method: "POST",
      headers: headers({
        Authorization: `Bearer ${tokens.access}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "session-id": sessionId,
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

  const refusals: string[] = [];
  for (const model of modelCandidates(configured)) {
    let res = await send(auth.tokens, model);

    // An access token can be revoked before its stated expiry. Renew once and
    // retry; a second 401 is a real answer.
    if (!(res instanceof Error) && res.status === 401) {
      auth = await accessToken(true);
      if ("error" in auth) return { error: auth.error };
      res = await send(auth.tokens, model);
    }

    if (res instanceof Error) {
      await logError("codex-research", res, "responses request");
      return { error: "Could not reach ChatGPT.", transient: true };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (isModelRejection(res.status, text)) {
        refusals.push(`${model} (${res.status})`);
        continue;
      }
      await logError("codex-research", `ChatGPT backend ${res.status}`, text.slice(0, 300));
      // 429 is the plan's usage limit. It lifts on its own; the sweep should
      // stop for now rather than work down the list.
      const transient = res.status === 429 || res.status >= 500;
      return transient
        ? { error: `ChatGPT is unavailable or over its usage limit (${res.status}).`, transient: true }
        : { error: `ChatGPT refused the request (${res.status}).` };
    }

    const parsed = parseCodexStream(text);
    if (parsed.failed) {
      if (isModelRejection(400, parsed.failed)) {
        refusals.push(`${model} (${parsed.failed.slice(0, 60)})`);
        continue;
      }
      await logError("codex-research", "ChatGPT response failed", parsed.failed.slice(0, 300));
      return { error: `ChatGPT could not answer: ${parsed.failed.slice(0, 120)}` };
    }

    // The model that answered is not the one the workspace had — it retired,
    // or was never on this plan. Save the one that works, so the next call
    // goes straight to it, and leave a row saying so.
    if (model !== (configured ?? CODEX_DEFAULT_MODEL)) {
      await putSetting(CODEX_MODEL_KEY, model);
      await logError(
        "codex-research",
        `Research model switched to ${model}`,
        `Was ${configured ?? `the default (${CODEX_DEFAULT_MODEL})`}. Refused: ${refusals.join(", ") || "retired, skipped"}.`,
      );
    }
    return { text: parsed.text, incomplete: parsed.incomplete };
  }

  await logError("codex-research", "Every research model was refused", refusals.join(", "));
  return {
    error: `ChatGPT refused every research model (${refusals.join(", ")}). Set one your plan offers in Settings.`,
  };
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
  // The same rule research follows: an answer with no finished signal is not
  // an answer. Without this, a connection dropping mid-reply showed "Working".
  if (result.incomplete) {
    return { ok: false, error: "ChatGPT's test response was interrupted before it finished." };
  }
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
