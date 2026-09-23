import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  REFRESH_MARGIN_MS,
  accountIdFromToken,
  needsRefresh,
  parseCodexStream,
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

test("A STREAM CUT SHORT STILL YIELDS WHAT WAS WRITTEN", () => {
  const parsed = parseCodexStream(
    sse(
      { type: "response.output_text.delta", delta: "Company: " },
      { type: "response.output_text.delta", delta: "Acme" },
    ),
  );
  assert.equal(parsed.text, "Company: Acme");
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
  assert.match(renew, /putSetting\(CODEX_TOKENS_KEY, JSON\.stringify\(renewed\.tokens\), tx\)/, "the new pair is stored inside the lock");
  assert.match(renew, /if \(renewed\.revoked\) await putSetting\(CODEX_TOKENS_KEY, "", tx\)/, "a dead login is cleared, not retried forever");
});

test("THE REQUEST MATCHES WHAT THE CHATGPT BACKEND REQUIRES", () => {
  assert.match(codex, /"https:\/\/chatgpt\.com\/backend-api\/codex\/responses"/);
  assert.match(codex, /store: false,/, "the backend refuses stored responses");
  assert.match(codex, /stream: true,/, "and only streams");
  assert.match(codex, /"chatgpt-account-id": tokens\.accountId/);
  assert.match(codex, /tools: input\.webSearch \? \[\{ type: "web_search" \}\] : \[\]/);
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
