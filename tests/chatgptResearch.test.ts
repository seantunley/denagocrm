import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  REFRESH_MARGIN_MS,
  CODEX_DEFAULT_MODEL,
  CODEX_MODEL_FALLBACKS,
  accountIdFromToken,
  isModelRejection,
  isRetiredModel,
  modelCandidates,
  needsRefresh,
  parseCodexStream,
  renewedByAnotherHolder,
} from "../src/lib/codexProtocol";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * Lead research can run on a workspace's ChatGPT subscription instead of
 * pay-per-token Anthropic credit — OpenAI's sanctioned "sign in with ChatGPT"
 * for third-party agents, the same mechanism OpenClaw uses.
 */

function jwt(claims: Record<string, unknown>): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.signature`;
}

const sse = (...events: Record<string, unknown>[]) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");

/* ── the protocol, executed ─────────────────────────────────────────── */

test("THE ACCOUNT ID IS READ FROM THE TOKEN'S OPENAI CLAIM", () => {
  const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
  assert.equal(accountIdFromToken(token), "acct_123");

  assert.equal(accountIdFromToken(jwt({ sub: "x" })), null, "no claim, no id");
  assert.equal(accountIdFromToken("not-a-jwt"), null, "garbage does not throw");
  assert.equal(accountIdFromToken(undefined), null);
});

test("A TOKEN IS RENEWED BEFORE IT EXPIRES, NOT AFTER", () => {
  const now = 1_000_000_000;
  assert.equal(needsRefresh({ expires: now + REFRESH_MARGIN_MS + 1000 }, now), false, "comfortably valid");
  assert.equal(needsRefresh({ expires: now + REFRESH_MARGIN_MS - 1000 }, now), true, "inside the margin");
  assert.equal(needsRefresh({ expires: now - 1 }, now), true, "already expired");
  assert.equal(needsRefresh({ expires: Number.NaN }, now), true, "unknown expiry is treated as expired");
});

test("THE DEFAULT MODEL IS ONE CHATGPT SIGN-IN STILL SERVES", () => {
  // gpt-5.4 was the default, and OpenAI withdrew it from ChatGPT-authenticated
  // Codex on 31 August 2026: every fresh connection failed on its first call.
  assert.equal(CODEX_DEFAULT_MODEL, "gpt-5.6-terra", "OpenAI's named replacement for gpt-5.4");
  assert.equal(isRetiredModel(CODEX_DEFAULT_MODEL, new Date("2026-09-23")), false);
  assert.equal(CODEX_MODEL_FALLBACKS[0], CODEX_DEFAULT_MODEL, "the default is tried first");
  for (const model of CODEX_MODEL_FALLBACKS) {
    assert.equal(isRetiredModel(model, new Date("2026-09-23")), false, `${model} is not a retired fallback`);
  }
});

test("A STORED RETIRED MODEL IS SKIPPED, NOT TRIED", () => {
  const today = new Date("2026-09-23T10:00:00Z");
  // A workspace connected before 31 Aug, still set to gpt-5.4, goes straight to Terra.
  assert.equal(modelCandidates("gpt-5.4", today)[0], "gpt-5.6-terra");
  assert.equal(modelCandidates("gpt-5.4-mini", today)[0], "gpt-5.6-terra");

  // gpt-5.5 still works today, and stops being tried on the day it retires.
  assert.equal(modelCandidates("gpt-5.5", today)[0], "gpt-5.5");
  assert.equal(modelCandidates("gpt-5.5", new Date("2026-10-14T00:00:00Z"))[0], "gpt-5.6-terra");

  // A live choice is honoured, and nothing is tried twice.
  const candidates = modelCandidates("gpt-6-sol", today);
  assert.equal(candidates[0], "gpt-6-sol");
  assert.equal(new Set(candidates).size, candidates.length);
  assert.deepEqual(modelCandidates(null, today), [...CODEX_MODEL_FALLBACKS]);
});

test("ONLY A REFUSED MODEL WALKS THE LIST", () => {
  assert.equal(isModelRejection(400, '{"detail":"The model gpt-5.4 is not supported with ChatGPT accounts"}'), true);
  assert.equal(isModelRejection(404, "model_not_found: The model does not exist"), true);
  assert.equal(isModelRejection(400, "Model gpt-6-sol is not available on your plan"), true);

  // These fail the same way whatever model is asked for.
  assert.equal(isModelRejection(429, "model usage limit reached"), false, "a usage limit is not a model problem");
  assert.equal(isModelRejection(401, "invalid model token"), false, "nor an expired sign-in");
  assert.equal(isModelRejection(503, "model overloaded"), false, "nor an outage");
  assert.equal(isModelRejection(400, "instructions are not valid"), false, "nor a bad request about something else");
});

test("A REQUEST THAT WAITED FOR THE LOCK USES THE PAIR ALREADY RENEWED", () => {
  const now = 1_000_000_000;
  const fresh = now + 60 * 60 * 1000;
  // Somebody renewed while we waited: the stored access token changed and is fresh.
  assert.equal(renewedByAnotherHolder({ access: "new", expires: fresh }, { access: "old" }, now), true);
  // Nobody did: same token as we first saw, so we are the one to renew.
  assert.equal(renewedByAnotherHolder({ access: "old", expires: now }, { access: "old" }, now), false);
  // Changed but already stale again (a long wait): renew rather than use it.
  assert.equal(renewedByAnotherHolder({ access: "new", expires: now }, { access: "old" }, now), false);
});

test("THE STREAM'S FINISHED TEXT COMES FROM THE COMPLETED EVENT", () => {
  const raw = sse(
    { type: "response.output_text.delta", delta: "partial" },
    {
      type: "response.completed",
      response: {
        output: [
          { type: "web_search_call" },
          {
            type: "message",
            // Cited prose arrives split at every citation boundary; it must be
            // joined without newlines or the briefing card shreds.
            content: [
              { type: "output_text", text: "Company: Acme builds estates" },
              { type: "output_text", text: ", in Cape Town." },
            ],
          },
        ],
      },
    },
  );
  const parsed = parseCodexStream(raw);
  assert.equal(parsed.text, "Company: Acme builds estates, in Cape Town.");
  assert.equal(parsed.incomplete, false);
  assert.equal(parsed.failed, null);
});

test("A STREAM CUT SHORT IS INCOMPLETE, HOWEVER FINISHED ITS TEXT LOOKS", () => {
  /*
   * The first version of this test reproduced the bug and asserted the wrong
   * thing about it: deltas with no terminal event came back as complete text,
   * and research saved a briefing cut off mid-sentence as the finished note.
   * Only a terminal event says the answer is whole.
   */
  const parsed = parseCodexStream(
    sse(
      { type: "response.output_text.delta", delta: "Company: Acme builds estates" },
      { type: "response.output_text.delta", delta: " in Cape Town. Role: Director of" },
    ),
  );
  assert.equal(parsed.incomplete, true, "no response.completed means not finished");
  assert.equal(parsed.failed, null);
  assert.equal(parsed.text, "Company: Acme builds estates in Cape Town. Role: Director of", "what arrived is kept, for the log");

  assert.equal(parseCodexStream("").incomplete, true, "an empty stream is not a finished answer either");

  // And research turns that into a refusal, not a saved note.
  const ai = stripComments(src("src/lib/ai.ts"));
  assert.match(ai, /stopReason = reply\.incomplete \? "max_tokens" : "end_turn";/);
  assert.match(ai, /if \(stopReason === "max_tokens"\) \{[\s\S]{0,400}return \{ error: "Research was cut off/);
});

test("A TRUNCATED ANSWER IS FLAGGED, SO IT IS NOT SAVED AS FINISHED", () => {
  const parsed = parseCodexStream(
    sse({
      type: "response.incomplete",
      response: { output: [{ type: "message", content: [{ type: "output_text", text: "Company: Ac" }] }] },
    }),
  );
  assert.equal(parsed.incomplete, true);
  assert.equal(parsed.text, "Company: Ac");
});

test("A FAILED RESPONSE CARRIES ITS REASON", () => {
  assert.equal(
    parseCodexStream(sse({ type: "response.failed", response: { error: { message: "model not found" } } })).failed,
    "model not found",
  );
  assert.equal(parseCodexStream(sse({ type: "error", message: "usage limit reached" })).failed, "usage limit reached");
  assert.equal(parseCodexStream("data: [DONE]\n\ndata: {not json}\n").text, "", "noise is ignored, not thrown");
});

/* ── the wiring ────────────────────────────────────────────────────── */

const codex = stripComments(src("src/lib/codex.ts"));

test("TOKEN RENEWAL IS SERIALISED, BECAUSE THE REFRESH TOKEN IS SINGLE-USE", () => {
  const renew = codex.slice(codex.indexOf("async function accessToken"), codex.indexOf("export type CodexResult"));
  const lockAt = renew.indexOf("pg_advisory_xact_lock");
  const rereadAt = renew.indexOf("const latest = await readTokens()");
  const refreshAt = renew.indexOf('grant_type: "refresh_token"');
  assert.ok(lockAt > 0, "renewal takes a per-workspace lock");
  assert.ok(rereadAt > lockAt, "and re-reads the tokens AFTER taking it");
  assert.ok(refreshAt > rereadAt, "so a waiter uses the pair the first holder stored, instead of spending it again");
  const shortCircuitAt = renew.indexOf("if (renewedByAnotherHolder(latest, current)) return { tokens: latest };");
  assert.ok(
    shortCircuitAt > rereadAt && shortCircuitAt < refreshAt,
    "the waiter returns the stored pair BEFORE it would present its spent refresh token",
  );
  assert.match(renew, /putSetting\(CODEX_TOKENS_KEY, JSON\.stringify\(renewed\.tokens\), tx\)/, "the new pair is stored inside the lock");
  assert.match(renew, /if \(renewed\.revoked\) await putSetting\(CODEX_TOKENS_KEY, "", tx\)/, "a dead login is cleared, not retried forever");
});

test("THE REQUEST MATCHES WHAT THE CHATGPT BACKEND REQUIRES", () => {
  assert.match(codex, /"https:\/\/chatgpt\.com\/backend-api\/codex\/responses"/);
  assert.match(codex, /store: false,/, "the backend refuses stored responses");
  assert.match(codex, /stream: true,/, "and only streams");
  assert.match(codex, /"chatgpt-account-id": tokens\.accountId/);
  assert.match(codex, /tools: input\.webSearch \? \[\{ type: "web_search" \}\] : \[\]/);

  // Current upstream Codex (codex-rs core/src/client.rs): the header is
  // hyphenated, and ChatGPT derives Responses cache affinity from it.
  assert.match(codex, /"session-id": sessionId,/);
  assert.ok(!/session_id:/.test(codex), "not the underscored name the first version sent");
  // Upstream sends OpenAI-Beta only on its WebSocket transport.
  assert.ok(!/OpenAI-Beta|responses=experimental/.test(codex), "no unconfirmed beta header on HTTP");
});

test("A REFUSED MODEL IS REPLACED BY ONE THAT ANSWERS, AND THE CHANGE IS SAVED", () => {
  const call = codex.slice(codex.indexOf("export async function codexRespond"), codex.indexOf("export async function testCodexConnection"));
  assert.match(call, /for \(const model of modelCandidates\(configured\)\)/, "every call walks the candidates");
  assert.match(call, /if \(isModelRejection\(res\.status, text\)\) \{[\s\S]{0,120}continue;/, "an HTTP refusal tries the next");
  assert.match(call, /if \(isModelRejection\(400, parsed\.failed\)\) \{[\s\S]{0,120}continue;/, "so does a refusal inside the stream");
  assert.match(
    call,
    /if \(model !== \(configured \?\? CODEX_DEFAULT_MODEL\)\) \{\s*await putSetting\(CODEX_MODEL_KEY, model\);/,
    "the model that answered is saved, migrating a stored gpt-5.4",
  );
});

test("DISCONNECT REVOKES THE SIGN-IN AT OPENAI BEFORE FORGETTING IT", () => {
  const disconnect = codex.slice(codex.indexOf("export async function disconnectCodex"), codex.indexOf("async function postTokenForm"));
  const revokeAt = disconnect.indexOf("await revokeAtOpenAi(tokens)");
  const clearAt = disconnect.indexOf('putSetting(CODEX_TOKENS_KEY, ""');
  assert.ok(revokeAt > 0 && clearAt > revokeAt, "revoke first, then clear — once cleared there is nothing left to revoke with");
  // As upstream codex-rs login/src/auth/revoke.rs.
  assert.match(disconnect, /`\$\{AUTH_BASE\}\/oauth\/revoke`/);
  assert.match(disconnect, /token_type_hint: useRefresh \? "refresh_token" : "access_token"/);
  assert.match(disconnect, /\.\.\.\(useRefresh \? \{ client_id: CLIENT_ID \} : \{\}\)/);
  // Best-effort: a failed revoke is logged, and the local copy is still cleared.
  assert.ok(!/if \(!revoked\)[^\n]*return/.test(disconnect), "an unreachable OpenAI does not block disconnecting");
});

test("THE SIGN-IN IS STORED AS A CREDENTIAL, ENCRYPTED AT REST", () => {
  const settings = src("src/lib/settings.ts");
  const secrets = settings.slice(settings.indexOf("const SECRET_KEYS"), settings.indexOf("]);"));
  assert.match(secrets, /"CODEX_OAUTH_TOKENS"/, "the tokens");
  assert.match(secrets, /"CODEX_DEVICE_LOGIN"/, "and a pending sign-in, which can be completed by whoever holds it");
  assert.match(src("src/lib/securityRunbook.ts"), /"CODEX_OAUTH_TOKENS"/, "and the monthly check verifies it");
});

test("EVERY PIECE OF CHATGPT STATE IS PER WORKSPACE", () => {
  /*
   * A connection must only ever research the leads of the workspace that made
   * it — one workspace's subscription answering for another's customers is the
   * version of this that would clearly be misuse. That is enforced by WHERE the
   * state lives: getSetting/putSetting key every row on (tenantId, key), resolve
   * the tenant from the request scope, and throw rather than guess when there
   * is none. So the only thing to prove is that nothing here goes around them.
   */
  const sources = [codex, stripComments(src("src/app/actions/codex.ts"))].join("\n");
  assert.ok(!/appSetting|tenantIntegrationCredential/.test(sources), "no direct settings-table access");
  assert.ok(!/process\.env\.CODEX|process\.env\.OPENAI/.test(sources), "no deployment-wide credential");

  for (const key of ["CODEX_TOKENS_KEY", "CODEX_DEVICE_KEY", "CODEX_MODEL_KEY"]) {
    const reads = [...codex.matchAll(new RegExp(`(\\w+)\\(${key}`, "g"))].map((match) => match[1]);
    assert.ok(reads.length > 0, `${key} is used`);
    for (const fn of reads) {
      assert.ok(["getSetting", "putSetting"].includes(fn), `${key} only goes through tenant-scoped settings, not ${fn}`);
    }
  }

  // The settings screen shows the model from the same scoped read, not from
  // the page's bulk settings list.
  const page = src("src/app/(app)/settings/page.tsx");
  assert.ok(!/setting\("CODEX_/.test(page), "the page reads no Codex state from its bulk settings list");
  assert.match(page, /defaultValue=\{chatGpt\.model\}/);

  // The renewal lock is per workspace too, so one tenant's renewal never waits
  // on another's.
  assert.match(codex, /`codex-refresh:\$\{currentTenantScope\(\)\?\.tenantId/);
});

test("EVERY CHATGPT ACTION IS OWNER-ONLY", () => {
  const actions = stripComments(src("src/app/actions/codex.ts"));
  const exported = [...actions.matchAll(/export async function (\w+)\(\) \{([\s\S]*?)\n\}/g)];
  assert.deepEqual(
    exported.map((match) => match[1]).sort(),
    ["disconnectChatGpt", "pollChatGptLogin", "startChatGptLogin", "testChatGpt"],
  );
  for (const [, name, body] of exported) {
    assert.match(body.trim(), /^(const user = )?await requireOwner\(\);/, `${name} checks the owner FIRST`);
  }
});

test("A CONNECTED SUBSCRIPTION NEVER QUIETLY FALLS BACK TO API CREDIT", () => {
  const ai = stripComments(src("src/lib/ai.ts"));
  const research = ai.slice(ai.indexOf("export async function aiResearch"), ai.indexOf("export async function runAutoResearch"));
  assert.match(research, /const useChatGpt = await isCodexConnected\(\);/);
  assert.match(research, /const apiKey = useChatGpt \? null : await getSetting\("ANTHROPIC_API_KEY"\);/);
  // The Anthropic loop is skipped entirely when ChatGPT is in use, and a
  // ChatGPT failure returns rather than dropping through to it.
  assert.match(research, /for \(let attempt = 0; !useChatGpt && attempt <= MAX_CONTINUATIONS; attempt\+\+\)/);
  assert.match(research, /if \("error" in reply\) \{\s*return reply\.transient/);
});

test("RESEARCH IS AVAILABLE ON EITHER PROVIDER", () => {
  const ai = stripComments(src("src/lib/ai.ts"));
  assert.match(ai, /if \(!\(await isResearchConfigured\(\)\)\) return 0;/, "the automatic sweep runs on ChatGPT alone");
  for (const page of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/contacts/[id]/page.tsx"]) {
    assert.match(src(page), /configured=\{researchOn\}/, `${page} shows Research when only ChatGPT is connected`);
  }
});
