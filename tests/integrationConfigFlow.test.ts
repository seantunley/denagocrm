import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { commitVerifiedCredentials, type CommitDeps } from "../src/lib/integrationCommit";
import {
  redactSecrets,
  classifySmtpError,
  classifyGraphError,
  probeSmtp,
  probeWhatsApp,
  failureRequiresReauth,
  type ProbeResult,
} from "../src/lib/integrationProbe";
import {
  validateFlowStep,
  validateWholeFlow,
  getIntegrationFlow,
  flowFieldKeys,
  VERIFY_STEP_ID,
} from "../src/lib/integrationFlow";

/**
 * Guards for the guided integration setup / reauth flow.
 *
 * Two invariants matter more than the rest and are tested behaviourally, not by
 * matching source text:
 *
 *   1. An UNVERIFIED credential is never persisted. If the live connection test
 *      fails, `saveBundle` must not be called — otherwise the test is
 *      decoration and the feature is a lie.
 *   2. A SECRET never reaches an error message, a returned payload, or a log.
 *      Providers echo request context into failure bodies, so the probes build
 *      their own sentences and redact on top.
 *
 * No test here opens a socket. Every network dependency is injected — the same
 * `deps`-object pattern resolveTenantCredential uses (src/lib/settings.ts) — so
 * the classification logic is exercised against synthetic errors and CI never
 * touches the network.
 */

// Both carry the word "example" deliberately. .gitleaks.toml allowlists
// `(example|placeholder|redacted|your[-_]?(key|token|secret))` as documented
// placeholders, and without it a credential-shaped literal in a test fixture
// fails the secret scan. The value is never parsed, only carried through and
// compared, so its shape is irrelevant to what is tested.
const SECRET = "example-access-token-not-a-real-credential";
const SMTP_PASSWORD = "example-smtp-password-not-a-real-credential";

/** A deps object that records what the commit step actually did. */
function spyDeps(probeResult: ProbeResult) {
  const calls = { probe: 0, save: 0, verified: 0, failure: 0 };
  let savedValues: Record<string, string> | null = null;
  const deps: CommitDeps = {
    probe: async () => {
      calls.probe++;
      return probeResult;
    },
    saveBundle: async (values) => {
      calls.save++;
      savedValues = values;
    },
    recordVerified: async () => {
      calls.verified++;
    },
  };
  return { deps, calls, saved: () => savedValues };
}

const GOOD_SMTP = {
  SMTP_HOST: "mail.example.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "postmaster@example.com",
  SMTP_PASS: SMTP_PASSWORD,
  SMTP_FROM: "noreply@example.com",
};

/** The credential BUNDLE shape (AppSetting keys), as the flow collects it. */
const GOOD_WHATSAPP = {
  WA_PHONE_NUMBER_ID: "109876543210987",
  WA_ACCESS_TOKEN: SECRET,
};

/**
 * The PROBE INPUT shape, which is deliberately different — probeWhatsApp takes
 * named credentials rather than storage keys. Passing the bundle here instead
 * silently yields `accessToken: undefined`, which disarms redaction entirely;
 * that mistake is what the leak assertions below would otherwise pass through.
 */
const WA_PROBE = { phoneNumberId: "109876543210987", accessToken: SECRET };

// ── GUARD 1: an unverified credential is never saved ────────────────────────

test("a failed connection test never persists the credential", async () => {
  const { deps, calls, saved } = spyDeps({
    ok: false,
    code: "auth_failed",
    message: "The mail server rejected the username and password.",
    blameStep: "credentials",
  });

  const outcome = await commitVerifiedCredentials("smtp", GOOD_SMTP, deps);

  assert.equal(outcome.kind, "failed", "a rejected credential must not report success");
  assert.equal(calls.probe, 1, "the live test must actually have been attempted");
  assert.equal(
    calls.save,
    0,
    "PERSISTED AN UNVERIFIED CREDENTIAL: the connection test failed but saveBundle was still called, which makes the test decorative",
  );
  assert.equal(calls.verified, 0, "a failed test must not mark the integration verified");
  // There is deliberately no recordFailure dependency to call. The probe tested
  // CANDIDATE values that were never saved, so writing a failure against
  // IntegrationConnection would stamp the health of the tenant's currently
  // STORED bundle from a test of entirely different credentials — mistype a
  // password beside a working integration and the working one flips to
  // "Reconnect". Stored health is owned by retestIntegration (which probes what
  // is stored) and noteIntegrationSendOutcome (which reports real sends).
  assert.equal(
    (deps as Record<string, unknown>).recordFailure,
    undefined,
    "a candidate probe must have no way to write failure state onto the stored bundle",
  );
  assert.equal(saved(), null, "nothing at all should have been handed to the credential store");
});

test("a credential that fails shape validation is never probed and never saved", async () => {
  const { deps, calls } = spyDeps({ ok: true, detail: "unused", facts: [], warnings: [] });

  const outcome = await commitVerifiedCredentials("smtp", { ...GOOD_SMTP, SMTP_PORT: "not-a-port" }, deps);

  assert.equal(outcome.kind, "invalid", "a malformed port must be refused before anything else happens");
  assert.equal(calls.probe, 0, "invalid input must not spend a live connection test");
  assert.equal(calls.save, 0, "PERSISTED AN UNVERIFIED CREDENTIAL: invalid input reached the credential store");
});

test("only a passing connection test persists, and it persists the whole bundle at once", async () => {
  const { deps, calls, saved } = spyDeps({
    ok: true,
    detail: "Opened a connection to mail.example.com:587 and signed in.",
    facts: [{ label: "Server", value: "mail.example.com:587" }],
    warnings: [],
  });

  const outcome = await commitVerifiedCredentials("smtp", GOOD_SMTP, deps);

  assert.equal(outcome.kind, "connected");
  assert.equal(calls.save, 1, "a verified credential must be saved exactly once");
  assert.equal(calls.verified, 1, "a verified credential must be marked verified");
  assert.deepEqual(
    Object.keys(saved() ?? {}).sort(),
    Object.keys(GOOD_SMTP).sort(),
    "the whole bundle must be committed together, not field by field",
  );
});

test("an unknown integration is neither probed nor saved", async () => {
  const { deps, calls } = spyDeps({ ok: true, detail: "unused", facts: [], warnings: [] });
  const outcome = await commitVerifiedCredentials("not-a-real-integration", GOOD_SMTP, deps);
  assert.equal(outcome.kind, "unknown_integration");
  assert.equal(calls.probe, 0);
  assert.equal(calls.save, 0, "an unrecognised integration id must never reach the credential store");
});

test("keys outside the flow's own field list are dropped rather than written", async () => {
  const { deps, saved } = spyDeps({ ok: true, detail: "ok", facts: [], warnings: [] });

  await commitVerifiedCredentials(
    "whatsapp",
    { ...GOOD_WHATSAPP, SMTP_PASS: "injected", ANTHROPIC_API_KEY: "injected" },
    deps,
  );

  assert.deepEqual(
    Object.keys(saved() ?? {}).sort(),
    ["WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID"],
    "a client-supplied key from another integration must not be written through this flow",
  );
});

// ── GUARD 2: a secret never reaches an error message or a log ───────────────

test("redactSecrets removes a known secret wherever it appears", () => {
  const masked = redactSecrets(`Meta said: invalid token ${SECRET} for app`, [SECRET]);
  assert.doesNotMatch(masked, new RegExp(SECRET), "LEAKED SECRET: the token survived redaction");
  assert.match(masked, /\[redacted\]/);
});

test("redactSecrets masks token-shaped text even when the secret was not declared", () => {
  const masked = redactSecrets(`request failed: Authorization: Bearer ${SECRET}`, []);
  assert.doesNotMatch(masked, new RegExp(SECRET), "LEAKED SECRET: an undeclared bearer token survived redaction");
});

test("redactSecrets masks secrets containing regex metacharacters", () => {
  const awkward = "p@ss.*w[or]d+$(x)";
  const masked = redactSecrets(`auth failed for ${awkward}`, [awkward]);
  assert.doesNotMatch(masked, /p@ss/, "LEAKED SECRET: a password with regex metacharacters survived redaction");
});

test("redactSecrets masks a longer secret fully rather than leaving a recognisable tail", () => {
  const short = "abcd";
  const long = "abcd-efgh-ijkl";
  const masked = redactSecrets(`token ${long} rejected`, [short, long]);
  assert.doesNotMatch(masked, /efgh/, "LEAKED SECRET: part of the longer secret survived redaction");
});

test("a failed SMTP probe never echoes the password back", async () => {
  // A real nodemailer EAUTH error quotes the server's response, which can carry
  // the credentials that were offered.
  const err = Object.assign(new Error(`535 5.7.8 Authentication failed for user postmaster with password ${SMTP_PASSWORD}`), {
    code: "EAUTH",
    responseCode: 535,
  });

  const result = await probeSmtp(
    {
      host: "mail.example.com",
      port: 587,
      secure: false,
      user: "postmaster@example.com",
      pass: SMTP_PASSWORD,
      from: "noreply@example.com",
    },
    {
      verify: async () => {
        throw err;
      },
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(
    result.message,
    new RegExp(SMTP_PASSWORD),
    "LEAKED SECRET: the SMTP password reached an error message shown in the browser",
  );
  assert.equal(result.code, "auth_failed");
  assert.equal(result.blameStep, "credentials", "an auth failure must send the user back to the sign-in step");
});

test("a failed WhatsApp probe never echoes the access token back", async () => {
  const result = await probeWhatsApp(WA_PROBE, {
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            message: `Invalid OAuth access token ${SECRET} - cannot parse access token`,
            code: 190,
            type: "OAuthException",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    checkWebhook: async () => ({ reachable: true, detail: "answered 403" }),
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(
    result.message,
    new RegExp(SECRET),
    "LEAKED SECRET: the WhatsApp access token reached an error message shown in the browser",
  );
  assert.equal(result.code, "auth_failed");
});

test("a successful WhatsApp probe never echoes the access token into its facts", async () => {
  const result = await probeWhatsApp(WA_PROBE, {
    fetch: async () =>
      new Response(
        JSON.stringify({ verified_name: `Shop ${SECRET}`, display_phone_number: "+27 21 555 0100", quality_rating: "GREEN" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    checkWebhook: async () => ({ reachable: true, detail: "answered 403" }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rendered = JSON.stringify(result);
  assert.doesNotMatch(
    rendered,
    new RegExp(SECRET),
    "LEAKED SECRET: the access token reached the success payload returned to the browser",
  );
});

test("the probe module has no logging sink at all", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src = readFileSync(join(root, "src/lib/integrationProbe.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /console\.(log|warn|error|info|debug)/, "LEAKED SECRET RISK: the probe module writes to the console, and secrets pass through it");
  assert.doesNotMatch(code, /logError|logAudit/, "LEAKED SECRET RISK: the probe module writes to a log sink, and secrets pass through it");
});

test("the audit entries written by the flow record key names, never values", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const src = readFileSync(join(root, "src/app/actions/integrationFlow.ts"), "utf8");
  const auditCalls = src.match(/logAuditStrict\(\{[\s\S]*?\n  \}\);/g) ?? [];
  assert.ok(auditCalls.length >= 2, "expected the connect and failure paths to both write an audit entry");
  for (const call of auditCalls) {
    assert.doesNotMatch(
      call,
      /\bclean\b|\bvalues\b|\bsecrets\b/,
      "LEAKED SECRET: an audit entry in the integration setup carries the submitted credential values",
    );
  }
});

// ── Probe classification: specific causes, not a boolean ────────────────────

const SMTP_INPUT = {
  host: "mail.example.com",
  port: 587,
  secure: false,
  user: "postmaster@example.com",
  pass: SMTP_PASSWORD,
  from: "noreply@example.com",
};

test("SMTP failures are classified into distinct, actionable causes", () => {
  const cases: { err: Record<string, unknown>; code: string; blameStep: string }[] = [
    { err: { code: "EAUTH", responseCode: 535 }, code: "auth_failed", blameStep: "credentials" },
    { err: { code: "ENOTFOUND" }, code: "unreachable", blameStep: "server" },
    { err: { code: "ECONNREFUSED" }, code: "unreachable", blameStep: "server" },
    { err: { code: "ETIMEDOUT" }, code: "timeout", blameStep: "server" },
    { err: { code: "ESOCKET", message: "wrong version number" }, code: "tls_failed", blameStep: "server" },
    { err: { code: "EENVELOPE", responseCode: 550 }, code: "identity_mismatch", blameStep: "identity" },
    { err: { code: "ESOMETHINGELSE", responseCode: 421 }, code: "provider_error", blameStep: VERIFY_STEP_ID },
  ];
  for (const c of cases) {
    const result = classifySmtpError(c.err, SMTP_INPUT);
    assert.equal(result.code, c.code, `SMTP error ${String(c.err.code)} should classify as ${c.code}`);
    assert.equal(result.blameStep, c.blameStep, `SMTP error ${String(c.err.code)} should be blamed on the ${c.blameStep} step`);
    assert.ok(result.message.length > 30, "a probe failure must be an explanatory sentence, not a code");
  }
});

test("Graph API failures distinguish a bad token from a bad phone number id", () => {
  const badToken = classifyGraphError(401, { error: { code: 190 } }, WA_PROBE);
  assert.equal(badToken.code, "auth_failed");
  assert.equal(badToken.blameStep, "credentials", "a rejected token must send the user back to the token step");

  const badNumber = classifyGraphError(400, { error: { code: 100 } }, WA_PROBE);
  assert.equal(badNumber.code, "identity_mismatch");
  assert.equal(
    badNumber.blameStep,
    "identity",
    "a token that works but cannot see the number must send the user back to the phone-number step, not the token step",
  );

  const thinToken = classifyGraphError(403, { error: { code: 10 } }, WA_PROBE);
  assert.equal(thinToken.code, "permission_denied");

  const expired = classifyGraphError(401, { error: { code: 190, error_subcode: 463 } }, WA_PROBE);
  assert.match(expired.message, /expired/i, "an expired token should say so — the fix differs from a revoked one");
});

test("a rate limit is blamed on the verify step, so nobody is told to re-type a working token", () => {
  const limited = classifyGraphError(429, { error: { code: 4 } }, WA_PROBE);
  assert.equal(limited.code, "rate_limited");
  assert.equal(limited.blameStep, VERIFY_STEP_ID);
});

test("a valid token with an unreachable webhook passes, but warns specifically", async () => {
  const result = await probeWhatsApp(WA_PROBE, {
    fetch: async () =>
      new Response(JSON.stringify({ verified_name: "Denago Cape Town", display_phone_number: "+27 21 555 0100" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    checkWebhook: async () => ({ reachable: false, detail: "the webhook route returned 404 Not Found" }),
  });

  assert.equal(result.ok, true, "a working token must not be rejected because the webhook is down — sending still works");
  if (!result.ok) return;
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "webhook_unreachable");
  assert.match(
    result.warnings[0].message,
    /token is valid.*webhook endpoint is unreachable/i,
    "the warning must name both halves: the credential is fine, the webhook is not",
  );
});

test("a reachable webhook produces no warning", async () => {
  const result = await probeWhatsApp(WA_PROBE, {
    fetch: async () => new Response(JSON.stringify({ verified_name: "Denago" }), { status: 200 }),
    checkWebhook: async () => ({ reachable: true, detail: "answered 403" }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
});

// ── Reauth policy ───────────────────────────────────────────────────────────

test("only credential-class failures demand reauth", () => {
  for (const code of ["auth_failed", "permission_denied", "identity_mismatch"] as const) {
    assert.equal(failureRequiresReauth(code), true, `${code} means the stored credential itself is wrong`);
  }
  for (const code of ["timeout", "unreachable", "rate_limited", "provider_error", "tls_failed", "invalid_input"] as const) {
    assert.equal(
      failureRequiresReauth(code),
      false,
      `${code} is survivable — flagging it would lock a tenant out of a working integration over a blip`,
    );
  }
});

test("every probe failure names a step that exists in that integration's flow", () => {
  for (const integrationId of ["smtp", "whatsapp"]) {
    const flow = getIntegrationFlow(integrationId);
    assert.ok(flow, `${integrationId} should have a flow`);
    const stepIds = new Set(flow!.steps.map((s) => s.id));
    assert.ok(stepIds.has(VERIFY_STEP_ID), "every flow must end with a verify step to fall back to");
  }

  const smtpSteps = new Set(getIntegrationFlow("smtp")!.steps.map((s) => s.id));
  for (const err of [{ code: "EAUTH" }, { code: "ENOTFOUND" }, { code: "EENVELOPE" }, { code: "EWEIRD" }]) {
    const failure = classifySmtpError(err, SMTP_INPUT);
    assert.ok(
      smtpSteps.has(failure.blameStep),
      `blameStep "${failure.blameStep}" does not exist in the SMTP flow, so reauth would route the user nowhere`,
    );
  }

  const waSteps = new Set(getIntegrationFlow("whatsapp")!.steps.map((s) => s.id));
  for (const status of [401, 403, 404, 429, 500]) {
    const failure = classifyGraphError(status, { error: { code: 0 } }, WA_PROBE);
    assert.ok(
      waSteps.has(failure.blameStep),
      `blameStep "${failure.blameStep}" does not exist in the WhatsApp flow, so reauth would route the user nowhere`,
    );
  }
});

// ── Step validation ─────────────────────────────────────────────────────────

test("a validation message never echoes the value that was submitted", () => {
  // Contains characters no validator accepts, so EVERY validator reaches its
  // rejection branch. A value that some field happens to consider valid would
  // make this test vacuous for that field — it would assert nothing about a
  // message that was never produced.
  const nasty = "s3cr3t!value#must-not-appear";
  let messagesChecked = 0;
  for (const integrationId of ["smtp", "whatsapp"]) {
    const flow = getIntegrationFlow(integrationId)!;
    const values = Object.fromEntries(flowFieldKeys(flow).map((k) => [k, nasty]));
    const errors = validateWholeFlow(integrationId, values);
    for (const [key, message] of Object.entries(errors)) {
      messagesChecked++;
      assert.doesNotMatch(
        message,
        new RegExp(nasty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `LEAKED SECRET: the validation message for ${key} echoes the submitted value back into the browser`,
      );
    }
  }
  // Five fields have a format this value violates: SMTP_HOST, SMTP_PORT,
  // SMTP_SECURE, SMTP_FROM and WA_PHONE_NUMBER_ID. The remaining three
  // (SMTP_USER, SMTP_PASS, WA_ACCESS_TOKEN) accept any non-empty string by
  // design, so they produce no message to inspect. If this count drops, a
  // validator stopped rejecting and this guard quietly stopped covering it.
  assert.equal(
    messagesChecked,
    5,
    `expected 5 validation messages to inspect but got ${messagesChecked} — a validator changed, so this guard may no longer cover the field you think it does`,
  );
});

test("each step validates only its own fields, so a later blank never blocks Next", () => {
  const errors = validateFlowStep("smtp", "server", {
    SMTP_HOST: "mail.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "true",
  });
  assert.deepEqual(errors, {}, "the sign-in step's empty password must not block the mail-server step");
});

test("encryption must be stated outright — blank is not a value this flow can honestly test", () => {
  // THE BUNDLE THAT WAS TESTED MUST BE THE BUNDLE THAT IS STORED. Blank broke
  // that in both directions: the probe read it as `false` and tested an
  // unencrypted connection, while putTenantCredentialBundle skips empty values,
  // so an existing SMTP_SECURE=true override survived untouched — verified one
  // way, stored the other. The flow now refuses to guess.
  const blank = validateFlowStep("smtp", "server", { SMTP_HOST: "a.example.com", SMTP_PORT: "587", SMTP_SECURE: "" });
  assert.ok(blank.SMTP_SECURE, "blank encryption must be rejected, not silently probed as off");

  const bad = validateFlowStep("smtp", "server", { SMTP_HOST: "a.example.com", SMTP_PORT: "587", SMTP_SECURE: "maybe" });
  assert.ok(bad.SMTP_SECURE, "a supplied encryption value must still be validated");

  for (const value of ["true", "false"]) {
    assert.deepEqual(
      validateFlowStep("smtp", "server", { SMTP_HOST: "a.example.com", SMTP_PORT: "587", SMTP_SECURE: value }),
      {},
      `an explicit "${value}" is exactly what the flow wants`,
    );
  }
});

test("common setup mistakes get a specific correction rather than a generic rejection", () => {
  assert.match(validateFlowStep("smtp", "server", { SMTP_HOST: "https://mail.example.com", SMTP_PORT: "587", SMTP_SECURE: "true" }).SMTP_HOST, /without a https/i);
  assert.match(validateFlowStep("smtp", "server", { SMTP_HOST: "user@example.com", SMTP_PORT: "587", SMTP_SECURE: "true" }).SMTP_HOST, /email address/i);
  assert.match(validateFlowStep("smtp", "server", { SMTP_HOST: "a.example.com", SMTP_PORT: "70000", SMTP_SECURE: "true" }).SMTP_PORT, /1 and 65535/);
  assert.match(
    validateFlowStep("whatsapp", "identity", { WA_PHONE_NUMBER_ID: "+27 21 555 0100" }).WA_PHONE_NUMBER_ID,
    /phone number itself/i,
    "entering the phone number instead of its ID is the single most common WhatsApp setup mistake and deserves a named correction",
  );
  assert.match(
    validateFlowStep("whatsapp", "credentials", { WA_ACCESS_TOKEN: "EAAG abc\ndef" }).WA_ACCESS_TOKEN,
    /whitespace/i,
  );
});

test("a display-name From header is accepted, a malformed one is not", () => {
  assert.deepEqual(validateFlowStep("smtp", "identity", { SMTP_FROM: "Denago <sales@example.com>" }), {});
  assert.deepEqual(validateFlowStep("smtp", "identity", { SMTP_FROM: "sales@example.com" }), {});
  assert.ok(validateFlowStep("smtp", "identity", { SMTP_FROM: "sales@example" }).SMTP_FROM);
});

// ── Source-shape checks for the parts that genuinely need a database ────────

const root = fileURLToPath(new URL("..", import.meta.url));

test("the settings page never hands a secret to the client wizard", () => {
  const page = readFileSync(join(root, "src/app/(app)/settings/integration-overrides/page.tsx"), "utf8");
  assert.match(
    page,
    /if \(isSecretSettingKey\(key\)\) continue;/,
    "the prefill loop must skip secret keys, or a stored password would be sent to the browser",
  );
  // The only place stored credential VALUES are read on this page.
  const bundleReads = page.match(/resolveIntegrationBundle\(/g) ?? [];
  assert.equal(bundleReads.length, 1, "a second bundle read on this page would need its own secret filter");
});

test("the connection store never writes a raw provider message", () => {
  const src = readFileSync(join(root, "src/lib/integrationConnection.ts"), "utf8");
  assert.match(
    src,
    /const text = redactSecrets\(failure\.message, secrets\)/,
    "failure text must be redacted on the way into the database",
  );
});

test("the credential bundle is committed in a single transaction", () => {
  const src = readFileSync(join(root, "src/lib/settings.ts"), "utf8");
  const fn = /export async function putTenantCredentialBundle[\s\S]*?\n}/.exec(src)?.[0] ?? "";
  assert.match(fn, /\$transaction/, "a partially-written bundle would no longer match what was verified");
  assert.match(fn, /storedSettingValue\(key, value\)/, "the bundle writer must use the shared encryption rule");
  assert.match(fn, /tenantId_key: \{ tenantId, key \}/, "every row must be pinned to the caller's explicit tenantId");
});

test("the send paths report auth failures so an expired credential cannot fail silently", () => {
  const wa = readFileSync(join(root, "src/lib/whatsapp.ts"), "utf8");
  assert.match(wa, /noteWhatsAppOutcome\(phoneNumberId, token, res, err\)/, "a failed WhatsApp send must report its outcome");
  assert.match(wa, /classifyGraphError/, "the send path must reuse the setup flow's classifier");

  const email = readFileSync(join(root, "src/lib/email.ts"), "utf8");
  assert.match(email, /noteSmtpOutcome\(config, err\)/, "a failed email send must report its outcome");
  assert.match(email, /classifySmtpError/, "the send path must reuse the setup flow's classifier");
});

test("the wizard masks every secret field it collects", () => {
  const component = readFileSync(join(root, "src/components/integration-config-flow.tsx"), "utf8");
  const declared = /const SECRET_FIELD_KEYS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(component)?.[1] ?? "";
  const masked = new Set((declared.match(/"([A-Z_]+)"/g) ?? []).map((s) => s.replace(/"/g, "")));

  // Mirrors SECRET_KEYS in src/lib/settings.ts, which the component cannot import.
  const settings = readFileSync(join(root, "src/lib/settings.ts"), "utf8");
  const secretBlock = /const SECRET_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(settings)?.[1] ?? "";
  const realSecrets = new Set((secretBlock.match(/"([A-Z_]+)"/g) ?? []).map((s) => s.replace(/"/g, "")));

  for (const integrationId of ["smtp", "whatsapp"]) {
    for (const key of flowFieldKeys(getIntegrationFlow(integrationId)!)) {
      if (!realSecrets.has(key)) continue;
      assert.ok(
        masked.has(key),
        `LEAKED SECRET: ${key} is a credential-class key but the wizard renders it as a visible text input`,
      );
    }
  }
});

test("IntegrationConnection carries the same RLS policy every other tenant table does", () => {
  // FORCE ROW LEVEL SECURITY has been live since 20260727130000_rls_enforce, so a
  // tenant-owned table added after it without a policy has no database-layer
  // boundary at all — only the app guard, which src/lib/db.ts documents as
  // defence-in-depth rather than the authoritative one. This table shipped with
  // tenantId and tenant indexes but none of the three RLS statements.
  const migration = readFileSync(
    join(root, "prisma/migrations/20260804093000_integration_connection/migration.sql"),
    "utf8",
  );
  assert.match(migration, /ALTER TABLE "IntegrationConnection" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE "IntegrationConnection" FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY "IntegrationConnection_tenant_isolation"/);
  assert.match(
    migration,
    /"tenantId" = current_setting\('app\.current_tenant', true\)/,
    "the policy must match on the request's tenant, exactly as RepairIssue's does",
  );
  // Comment lines stripped: the migration DISCUSSES the NULL escape hatch in
  // prose to explain why it is absent, and prose must not fail the check that
  // the SQL itself never grants one.
  const sql = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(
    sql,
    /"tenantId" IS NULL/,
    "there is no such thing as a tenantless integration connection — a NULL-matching clause would be a hole",
  );
});

test("editing a credential by hand drops the verification verdict that was about the old one", () => {
  // The per-key save/clear controls write TenantIntegrationCredential directly,
  // never through the wizard — so after one runs, nothing about the stored
  // bundle is proven. The page ranks lastVerifiedAt above override presence, so
  // without invalidation a replaced (or deleted) password still reads
  // "Connected, verified on the 3rd": the worst answer, confidently given.
  const src = readFileSync(join(root, "src/app/actions/tenantCredentials.ts"), "utf8");
  const save = src.slice(src.indexOf("export async function saveTenantCredentialOverride"), src.indexOf("export async function clearTenantCredentialOverride"));
  const clear = src.slice(src.indexOf("export async function clearTenantCredentialOverride"));
  assert.match(save, /invalidateVerificationForKey/, "saving a credential must invalidate its integration's verdict");
  assert.match(clear, /invalidateVerificationForKey/, "clearing a credential must invalidate it too — reverting to the platform default changes what the bundle IS");

  // And the invalidation must resolve the key back to its integration(s) rather
  // than guessing, so a key shared by two flows clears both.
  const flow = readFileSync(join(root, "src/lib/integrationFlow.ts"), "utf8");
  assert.match(flow, /export function integrationsUsingCredentialKey/);
  const conn = readFileSync(join(root, "src/lib/integrationConnection.ts"), "utf8");
  assert.match(conn, /export async function clearIntegrationVerification/);
  assert.match(
    conn,
    /deleteMany\(\{ where: \{ tenantId, integrationId \} \}\)/,
    "invalidation must DELETE (never verified) rather than claim the provider rejected anything",
  );
});
