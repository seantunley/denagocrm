import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { InboundRetryRequested, planLeasedRetry, retryLogPlan, retryResponseFor } from "../src/lib/inboundRetrySignal";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const WEBHOOKS: Array<{ route: string; source: string }> = [
  { route: "src/app/api/webhooks/whatsapp/route.ts", source: "whatsapp-webhook" },
  { route: "src/app/api/webhooks/meta/route.ts", source: "meta-dm-webhook" },
  { route: "src/app/api/webhooks/telegram/route.ts", source: "telegram-webhook" },
];

/**
 * "Please redeliver this" is a deliberate answer, and it has to look like one —
 * to the provider AND to the operator.
 *
 * The retry signal was thrown OUTSIDE the surrounding try on all three webhooks,
 * so it left the route as an unhandled rejection. Catching it at the outer
 * boundary fixed the status but not the visibility: that boundary is outside the
 * tenant scope wrapper, so `logError` found no scope, fell back to a staff session
 * a webhook does not have, and filed the row with `tenantId = null` — which the
 * System Log and the platform Errors tab both exclude. The row existed and the
 * operator still could not see it.
 *
 * The failure path had the opposite problem: the per-message handler logs and
 * rethrows, and the outer boundary logged the same error a second time.
 */

// ---------------------------------------------------------------------------
// The mapping itself, executed.
// ---------------------------------------------------------------------------

test("a leased event is answered 503 + Retry-After, and is already logged", () => {
  const decision = retryResponseFor(new InboundRetryRequested("leased", "whatsapp wamid.X"));
  assert.deepEqual(decision, { status: 503, retryAfterSeconds: 10, alreadyLogged: true });
});

test("a handled failure keeps its 500 and is not logged a second time", () => {
  // The whole double-log defect: this must report alreadyLogged, or the outer
  // boundary files a duplicate — unattributed once enforcement is on, so the two
  // copies of one failure do not even agree on whose it was.
  const decision = retryResponseFor(new InboundRetryRequested("failed", "messenger mid.Y"));
  assert.deepEqual(decision, { status: 500, alreadyLogged: true });
  assert.equal(decision.retryAfterSeconds, undefined, "a failure is not known to be transient");
});

test("an unexpected error is still logged, and answers 500", () => {
  const decision = retryResponseFor(new TypeError("something nobody planned for"));
  assert.equal(decision.status, 500);
  assert.equal(decision.alreadyLogged, false, "nobody has logged this one");
});

test("exactly one log per retry, owned, and the leased one cannot raise an alert", () => {
  // Count the rows a batch would actually file. A batch that hits one leased
  // message and one failed message must produce exactly ONE row: the failure was
  // already logged by the message handler, with its claim released.
  const plans = [
    retryLogPlan("leased", "tenant_b"),
    retryLogPlan("failed", "tenant_b"),
  ].filter(Boolean);
  assert.equal(plans.length, 1, `expected one log, got ${plans.length}`);

  const leased = retryLogPlan("leased", "tenant_b")!;
  assert.equal(leased.options.tenantId, "tenant_b", "the owner must survive the boundary");
  assert.equal(leased.options.alert, false, "a lease contention must never page anyone");
  assert.match(leased.context, /leased by another attempt/);

  // Omitting the tenant must not become an explicit null — that would tell
  // logError "unattributed" rather than "infer one".
  assert.equal("tenantId" in retryLogPlan("leased")!.options, false);
});

test("logError attributes to an explicitly supplied owner, and can be told not to alert", () => {
  // A webhook has no staff session to infer an owner from, so the caller that
  // KNOWS the tenant must be able to say so.
  const code = src("src/lib/errorLog.ts");
  assert.match(code, /const tenantId = options\?\.tenantId !== undefined \? options\.tenantId : await tenantForError\(\);/);
  // `!== undefined`, not `??` — passing an explicit null must mean "unattributed",
  // not "go and infer one".
  assert.doesNotMatch(code, /options\?\.tenantId \?\? await tenantForError/);
  assert.match(code, /if \(options\?\.alert === false\) return;/);
  // The switch has to sit BEFORE the push, or it does nothing. Match the CALL,
  // not the name — the option's own doc comment mentions it further up.
  assert.ok(code.indexOf("options?.alert === false") < code.indexOf("await sendPushToAll("));
  // ...and after the row is written, or suppressing the alert would also suppress
  // the log entry the operator is meant to see.
  assert.ok(code.indexOf("errorLog.create") < code.indexOf("options?.alert === false"));
});

// ---------------------------------------------------------------------------
// Wiring: the mapping above only matters if the routes reach it.
// ---------------------------------------------------------------------------

test("every inbound webhook answers its retry signals deliberately", () => {
  for (const { route, source } of WEBHOOKS) {
    const code = src(route);
    assert.match(code, /import \{ inboundRetryResponse, noteInboundRetry(, noteLeasedInbound)? \} from "@\/lib\/webhookRetry";/, `${route} does not handle its retry signal`);
    assert.match(
      code,
      new RegExp(`catch \\(error\\) \\{\\s*return inboundRetryResponse\\("${source}", error\\);`),
      `${route} must convert an escaping retry signal into a response`,
    );
  }
});

test("DORMANT enforcement, a leased event on tenant B's endpoint, end to end", async () => {
  // The case the previous round got wrong. `retryLogPlan` could carry a tenant and
  // the WhatsApp/Messenger routes never passed one — and withChannelTenantScope is
  // `if (!tenantEnforcing()) return fn();`, so being inside the wrapper tells you
  // nothing about the owner while dormant. The row still filed unattributed and
  // the workspace's System Log still excluded it.
  //
  // Run the actual composition with the resolver the route supplies.
  let lookups = 0;
  const endpointOwnedByB = async () => { lookups++; return "tenant_b"; };
  const { signal, log } = await planLeasedRetry("whatsapp wamid.X", endpointOwnedByB);

  assert.equal(lookups, 1, "the owner must be resolved from the endpoint, not assumed");
  assert.equal(log.options.tenantId, "tenant_b", "the ErrorLog row must belong to B");
  assert.equal(log.options.alert, false, "expected contention must never page anyone");
  assert.match(log.context, /leased by another attempt/);

  const response = retryResponseFor(signal);
  assert.equal(response.status, 503);
  assert.equal(response.retryAfterSeconds, 10);
  assert.equal(response.alreadyLogged, true, "the boundary must not file a second row");
});

test("an unmapped endpoint is not claimed for the founding tenant", async () => {
  // No owner is a real answer. `undefined` lets logError still infer one from an
  // enforced scope; an explicit null would assert the row is deliberately
  // unattributed, and guessing a tenant would blame a workspace that is fine.
  const { log } = await planLeasedRetry("whatsapp wamid.Y", async () => null);
  assert.equal("tenantId" in log.options, false);
  // A resolver that throws must not take the redelivery down with it.
  const { signal } = await planLeasedRetry("whatsapp wamid.Z", async () => { throw new Error("db down"); });
  assert.equal(retryResponseFor(signal).status, 503);
});

test("the batched routes resolve the owner from the endpoint they already have", () => {
  // WhatsApp has phone_number_id, Meta has the entry id. Both are exactly what
  // resolveChannelTenant maps, and both were already in scope at the throw site.
  const wa = src("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(wa, /noteLeasedInbound\("whatsapp-webhook", "whatsapp", phoneNumberId,/);
  const meta = src("src/app/api/webhooks/meta/route.ts");
  assert.match(meta, /noteLeasedInbound\("meta-dm-webhook", platform, endpointId,/);
  assert.match(src("src/lib/webhookRetry.ts"), /resolveChannelTenant\(channel, externalId\)/);

  // Telegram needs no lookup: its wrapper resolves the secret and enters
  // runInTenantScope regardless of enforcement, so the scope is already the owner.
  const tg = src("src/app/api/webhooks/telegram/route.ts");
  assert.match(tg, /noteInboundRetry\("telegram-webhook", "leased"/);
  assert.match(src("src/lib/telegramTenant.ts"), /if \(tenantId\) return runInTenantScope\(\{ tenantId, system: false \}, fn\)/);
});

test("the signal is raised where the tenant is known, never at the boundary", () => {
  for (const { route, source } of WEBHOOKS) {
    const code = src(route);
    // Raised through a helper that records the reason where the owner is known.
    // Constructing the old error directly would log at the boundary — or not at
    // all. The batched routes must additionally resolve the endpoint's tenant,
    // because their wrapper establishes no scope while enforcement is dormant.
    assert.match(
      code,
      new RegExp(`throw await noteLeasedInbound\\("${source}",|throw await noteInboundRetry\\("${source}", "leased"`),
      `${route} raises a leased signal without logging it in scope`,
    );
    assert.doesNotMatch(code, /new InboundBotEventLeasedError\(/, `${route} still raises the un-logged signal`);
  }
});

test("a message handler that already logged does not have its error logged again", () => {
  for (const route of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/meta/route.ts"]) {
    const code = src(route);
    const handler = code.slice(code.indexOf("await retryInboundBotEvent(claim, error)"));
    assert.match(handler.slice(0, 700), /await logError\(/, "the handler logs the real cause");
    assert.match(handler.slice(0, 700), /throw await noteInboundRetry\([^)]*"failed"/, "and must rethrow as an already-logged signal");
    assert.doesNotMatch(handler.slice(0, 700), /\n\s+throw error;/, "rethrowing the raw error double-logs it at the boundary");
  }
});

test("the signal cannot escape: every throw site is inside the handled region", () => {
  for (const { route } of WEBHOOKS) {
    const code = src(route);
    const handlerAt = code.indexOf("return inboundRetryResponse");
    const guardAt = code.lastIndexOf("\n  try {\n", handlerAt) >= 0
      ? code.lastIndexOf("\n  try {\n", handlerAt)
      : code.lastIndexOf("\n    try {\n", handlerAt);
    assert.ok(guardAt > 0 && handlerAt > guardAt, `${route} has no guarded region around its batch`);

    for (const marker of ["throw await noteInboundRetry"]) {
      let at = code.indexOf(marker);
      while (at !== -1) {
        assert.ok(at > guardAt && at < handlerAt, `${route}: \`${marker}\` at ${at} is outside the guarded region`);
        at = code.indexOf(marker, at + 1);
      }
    }
  }
});

test("the batch is not continued past a message we could not finish", () => {
  // A provider batch carries consecutive messages from one customer. Processing the
  // siblings of a failed message would answer their second question before the
  // first, and the redelivery replays the whole batch in order regardless.
  for (const route of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/meta/route.ts"]) {
    const code = src(route);
    const perMessageCatch = code.slice(code.indexOf("await retryInboundBotEvent(claim, error)"));
    assert.match(perMessageCatch.slice(0, 700), /throw await noteInboundRetry/, `${route} must abort the batch, not continue it`);
    assert.doesNotMatch(perMessageCatch.slice(0, 700), /\n\s+continue;/, `${route} must not skip past a failed message`);
  }
});
