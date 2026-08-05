import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { commitVerifiedCredentials, type CommitDeps } from "../src/lib/integrationCommit";
import { noteIntegrationSendOutcome } from "../src/lib/integrationConnection";
import { runAfterResponse } from "../src/lib/afterResponse";
import { credentialOwnerTenantId } from "../src/lib/settings";
import { currentTenantScope } from "../src/lib/tenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
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
  hasIntegrationFlow,
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
  assert.match(wa, /await noteWhatsAppOutcome\(creds, res, err\)/, "a failed WhatsApp send must report its outcome");
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

// ── Runtime send health: the right tenant, a real lifecycle, every path ──────
//
// The badge in Settings is only as honest as the runtime hook behind it, and
// that hook had three separate ways of reporting nothing at all:
//
//   (a) it re-derived the tenant from `currentTenantScope()`, which is a
//       deliberate NO-OP while enforcement is off — so on a normal
//       user-triggered send it found null and returned early;
//   (b) it was started unawaited, so a serverless invocation could be torn down
//       on top of the pending write; and
//   (c) only TEXT sends called it, so a token that expired while a tenant was
//       sending brochures and voice notes still read "Connected".
//
// Each guard below fails against that version.

/** Source with comments stripped — prose ABOUT a banned call must not trip a check. */
const shipped = (rel: string) =>
  readFileSync(join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Top-level `function name(...)` declarations, each mapped to its source text. */
function topLevelFunctions(code: string): Map<string, string> {
  const starts: { name: string; index: number }[] = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) starts.push({ name: m[1], index: m.index });
  const out = new Map<string, string>();
  starts.forEach((s, i) => {
    out.set(s.name, code.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : code.length));
  });
  return out;
}

/** Every call site of `name`, as the text leading up to and including the `(`. */
const callSites = (code: string, name: string) =>
  [...code.matchAll(new RegExp(`.{0,24}\\b${name}\\(`, "g"))].map((m) => m[0]);

const SEND_TENANT = "tenant_example_send_health";

// ── (a) the tenant is given, never looked up ────────────────────────────────

test("send health is recorded against the tenant it is GIVEN, with no ambient scope to read", async () => {
  // The PRODUCTION case, asserted rather than assumed: enforcement is off, so
  // the staff chokepoint enters no scope at all and there is no ambient tenant.
  // A hook that re-read scope here found null and returned early — which is why
  // the badge moved for cron probes and never for the sends that matter.
  assert.equal(currentTenantScope(), undefined, "this guard only means something with no ambient scope");

  const recorded: { tenantId: string; integrationId: string; code: string }[] = [];
  await noteIntegrationSendOutcome(
    SEND_TENANT,
    "whatsapp",
    { ok: false, failure: classifyGraphError(401, { error: { code: 190 } }, WA_PROBE) },
    [SECRET],
    {
      recordFailure: async (tenantId, integrationId, failure) => {
        recorded.push({ tenantId, integrationId, code: failure.code });
      },
    },
  );

  assert.deepEqual(
    recorded,
    [{ tenantId: SEND_TENANT, integrationId: "whatsapp", code: "auth_failed" }],
    "the hook must record against the explicit tenant it was handed, not one it goes looking for",
  );
});

test("a healthy send heals a stale badge, and is free when nothing was wrong", async () => {
  const verified: string[] = [];
  await noteIntegrationSendOutcome(SEND_TENANT, "smtp", { ok: true }, [], {
    read: async () => ({
      integrationId: "smtp",
      status: "reauth_required" as const,
      lastVerifiedAt: null,
      blameStep: "credentials",
      lastErrorCode: "auth_failed",
      lastErrorText: "rejected",
      lastErrorAt: new Date(),
    }),
    recordVerified: async (tenantId) => { verified.push(tenantId); },
  });
  assert.deepEqual(verified, [SEND_TENANT], "a send that worked must clear a Reconnect the tenant has since fixed");

  const again: string[] = [];
  await noteIntegrationSendOutcome(SEND_TENANT, "smtp", { ok: true }, [], {
    read: async () => ({
      integrationId: "smtp",
      status: "connected" as const,
      lastVerifiedAt: new Date(),
      blameStep: null,
      lastErrorCode: null,
      lastErrorText: null,
      lastErrorAt: null,
    }),
    recordVerified: async (tenantId) => { again.push(tenantId); },
  });
  assert.deepEqual(again, [], "an already-healthy integration must not take a row write on every single message");
});

test("credentials resolved with no tenant belong to the founding tenant, not to nobody", () => {
  // resolveIntegrationBundle / resolveTenantCredential fall back to the global
  // AppSetting row on a null tenant, and settingsOwnerTenantId owns that row for
  // the founding tenant. So "no tenant" is not "no owner" — and the founding
  // tenant is exactly what the overrides page reads its badges for.
  assert.equal(
    credentialOwnerTenantId(null),
    DEFAULT_TENANT_ID,
    "a send made with platform credentials must move the platform owner's badge",
  );
  assert.equal(credentialOwnerTenantId("tenant_other"), "tenant_other", "a real tenant is passed straight through");
});

test("the send-health hook takes a required tenant and can no longer be handed null", () => {
  const src = shipped("src/lib/integrationConnection.ts");
  const start = src.indexOf("export async function noteIntegrationSendOutcome");
  assert.ok(start !== -1, "noteIntegrationSendOutcome must still exist");
  const fn = src.slice(start, src.indexOf("export async function clearIntegrationVerification"));

  assert.doesNotMatch(
    fn,
    /tenantId: string \| null/,
    "a nullable tenant is what let real sends report nothing — make it required so callers must resolve one",
  );
  assert.doesNotMatch(fn, /if \(!tenantId\) return/, "the early return on a missing tenant was the silent drop");
  assert.doesNotMatch(
    src,
    /currentTenantScope|tenantScope/,
    "the connection store must never derive the acting tenant itself",
  );
});

test("neither send path re-reads ambient scope to decide whose health it is reporting", () => {
  const wa = shipped("src/lib/whatsapp.ts");
  const waNote = wa.slice(wa.indexOf("async function noteWhatsAppOutcome"), wa.indexOf("export function waDigits"));
  assert.ok(waNote.length > 0, "noteWhatsAppOutcome must still sit above waDigits");
  assert.doesNotMatch(
    waNote,
    /ambientTenantId\(\)|currentTenantScope\(\)/,
    "the WhatsApp hook must not ask scope a second question it cannot answer",
  );
  assert.match(waNote, /creds\.tenantId/, "the tenant must arrive with the resolved credentials");

  const email = shipped("src/lib/email.ts");
  const smtpNote = email.slice(
    email.indexOf("async function noteSmtpOutcome"),
    email.indexOf("export { renderTemplate }"),
  );
  assert.ok(smtpNote.length > 0, "noteSmtpOutcome must still sit above the renderTemplate re-export");
  assert.doesNotMatch(smtpNote, /currentTenantScope\(\)/, "the SMTP hook must not re-read ambient scope either");
  assert.match(smtpNote, /config\.tenantId/, "the tenant must arrive on the resolved SMTP config");
});

// ── (b) the write is seen through, not abandoned ────────────────────────────

test("post-response work is finished, not merely started, when there is no response to run after", async () => {
  // Cron sweeps, scripts and tests have no request scope, so `after()` is
  // unavailable and the only correct answer is to await. The old shape —
  // a fire-and-forget async IIFE — resolved the caller immediately and left the
  // write racing the end of the invocation.
  let finished = false;
  await runAfterResponse(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    finished = true;
  });
  assert.equal(finished, true, "the work must have completed by the time the caller continues");
});

test("inside a request the work is REGISTERED with the platform rather than run inline", async () => {
  const registered: (() => Promise<void>)[] = [];
  let ran = false;
  await runAfterResponse(async () => { ran = true; }, { after: (task) => { registered.push(task); } });

  assert.equal(registered.length, 1, "the work must be handed to after()/waitUntil, which extends the invocation");
  assert.equal(ran, false, "…and must not have been run inline, or it would add latency to the send");
  await registered[0]();
  assert.equal(ran, true, "the registered callback must be the work itself");
});

test("post-response bookkeeping still swallows its own failures", async () => {
  // Reaching the end of this test IS the assertion: neither layer may rethrow.
  await runAfterResponse(async () => { throw new Error("connection store unavailable"); });
  await noteIntegrationSendOutcome(SEND_TENANT, "smtp", { ok: true }, [], {
    read: async () => { throw new Error("table not migrated yet"); },
  });
  assert.ok(true, "a broken connection store must never surface as a failed send");
});

test("the send-health write goes through the post-response mechanism by default", () => {
  const conn = shipped("src/lib/integrationConnection.ts");
  assert.match(conn, /import \{ runAfterResponse \} from "\.\/afterResponse"/, "the default lifecycle must be the shared one");
  assert.match(conn, /deps\.schedule \?\? runAfterResponse/, "…and injectable only for tests");

  const after = shipped("src/lib/afterResponse.ts");
  assert.match(after, /import\("next\/server"\)/, "the platform mechanism is next/server's after()");
  assert.match(after, /await guarded\(\)/, "…with an awaited fallback wherever after() is unavailable");
});

test("no send path starts its bookkeeping and walks away", () => {
  for (const [rel, name] of [
    ["src/lib/whatsapp.ts", "noteWhatsAppOutcome"],
    ["src/lib/email.ts", "noteSmtpOutcome"],
  ] as const) {
    const code = shipped(rel);
    assert.doesNotMatch(
      code,
      /void \(async \(\) =>/,
      `${rel}: a fire-and-forget async IIFE is exactly the shape a serverless teardown eats`,
    );
    const sites = callSites(code, name);
    assert.ok(sites.length >= 3, `${rel}: expected the declaration plus several ${name} call sites, found ${sites.length}`);
    for (const site of sites) {
      if (site.includes("function ")) continue; // the declaration itself
      assert.ok(
        site.endsWith(`await ${name}(`),
        `${rel}: "${site.trim()}" is not awaited — the write is dropped when the invocation ends`,
      );
    }
  }
});

// ── (c) every path that spends the credential reports on it ─────────────────

test("every WhatsApp path that presents the access token reports how it went", () => {
  const bodies = topLevelFunctions(shipped("src/lib/whatsapp.ts"));

  // Named explicitly so renaming or adding an outbound path trips this guard
  // rather than quietly shrinking coverage.
  const OUTBOUND = [
    "fetchWhatsAppMedia",
    "sendInteractive",
    "sendWhatsAppAudioId",
    "sendWhatsAppButtons",
    "sendWhatsAppImage",
    "sendWhatsAppList",
    "sendWhatsAppText",
    "uploadWhatsAppMedia",
  ];
  assert.deepEqual(
    [...bodies.keys()].filter((n) => /^(send|upload|fetch)/.test(n)).sort(),
    OUTBOUND,
    "an outbound WhatsApp path was added or renamed — give it an entry here and make it report its outcome",
  );

  const silent: string[] = [];
  for (const name of OUTBOUND) {
    const body = bodies.get(name) ?? "";
    // Button and list messages carry no credentials of their own; they delegate.
    if (!/Bearer \$\{/.test(body)) {
      assert.match(body, /sendInteractive\(/, `${name} neither presents the token nor delegates to something that does`);
      continue;
    }
    if (!/noteWhatsAppOutcome\(/.test(body)) silent.push(name);
  }
  assert.deepEqual(
    silent,
    [],
    `these WhatsApp paths spend the same access token as sendWhatsAppText but report nothing, so a token that expires mid-flight stays "Connected" for as long as the failing sends happen to be media: ${silent.join(", ")}`,
  );

  // Both directions, not just failures: a success is what heals a stale badge.
  for (const name of ["sendWhatsAppImage", "uploadWhatsAppMedia", "sendWhatsAppAudioId", "sendInteractive"]) {
    assert.match(
      bodies.get(name) ?? "",
      /await noteWhatsAppOutcome\(creds, res, null\)/,
      `${name} must report success too, or a fixed integration never stops saying "Reconnect"`,
    );
  }
});

test("the media READ never turns an expired voice note into a demand to reconnect", () => {
  // Meta expires media after ~30 days, and that endpoint is addressed by media
  // id — so its 404 / code 100 would classify as `identity_mismatch`, which is
  // reauth-class. Only the token-class statuses are unambiguous there.
  const body = topLevelFunctions(shipped("src/lib/whatsapp.ts")).get("fetchWhatsAppMedia") ?? "";
  assert.match(body, /metaRes\.status === 401 \|\| metaRes\.status === 403/, "failures must be narrowed to token-class statuses");
  assert.match(body, /await noteWhatsAppOutcome\(creds, metaRes, null\)/, "a successful authenticated read still proves the token works");
  assert.equal(failureRequiresReauth("identity_mismatch"), true, "…which is why the narrowing above is load-bearing");
});

test("the SMTP send path reports both outcomes, matching WhatsApp", () => {
  const code = shipped("src/lib/email.ts");
  const send = code.slice(code.indexOf("export async function sendEmail"), code.indexOf("async function noteSmtpOutcome"));
  assert.match(send, /await noteSmtpOutcome\(config, null\)/, "a successful send must heal a stale Reconnect badge");
  assert.match(send, /await noteSmtpOutcome\(config, err\)/, "a failed send must report why");

  // WhatsApp's six outbound calls are enumerated above because they are six.
  // SMTP has exactly one, and the equivalent guard is that it stays that way: a
  // second transport built anywhere in this module would be a send whose failures
  // nothing reports, which is how sendWhatsAppImage came to be silent.
  const transports = code.match(/createTransport\(/g) ?? [];
  assert.equal(
    transports.length,
    1,
    "a second SMTP transport appeared in email.ts — route it through sendEmail, or it sends mail whose failures never reach the badge",
  );
  assert.ok(send.includes("createTransport("), "…and the one transport must be the one inside sendEmail");
});

test("health is only ever recorded for an integration the owner can actually reconnect", () => {
  // The reauth panel promises "The setup below opens at the step that needs
  // fixing", and that setup only renders for an integration with a guided flow
  // (hasIntegrationFlow). Reporting a send failure for one without a flow would
  // therefore paint "This integration has stopped working" above nothing at all.
  //
  // This is why telegram, sms and meta — which also send through tenant
  // credentials — are deliberately NOT wired to this hook: there is no probe to
  // classify their failures with and no flow to send the owner to. Giving one of
  // them a flow and a classifier is what unlocks it, and this guard is what makes
  // the wrong order fail loudly.
  const reported = new Set<string>();
  for (const file of readdirSync(join(root, "src/lib")).filter((name) => name.endsWith(".ts"))) {
    const code = shipped(join("src/lib", file));
    for (const m of code.matchAll(/noteIntegrationSendOutcome\([^,]+,\s*"([^"]+)"/g)) reported.add(m[1]);
  }

  assert.deepEqual([...reported].sort(), ["smtp", "whatsapp"], "the integrations reporting send health");
  for (const integrationId of reported) {
    assert.ok(
      hasIntegrationFlow(integrationId),
      `"${integrationId}" reports send health but has no guided flow, so a failure would demand a reconnect the settings page cannot offer`,
    );
  }
});
