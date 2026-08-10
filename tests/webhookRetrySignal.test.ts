import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const WEBHOOKS: Array<{ route: string; source: string }> = [
  { route: "src/app/api/webhooks/whatsapp/route.ts", source: "whatsapp-webhook" },
  { route: "src/app/api/webhooks/meta/route.ts", source: "meta-dm-webhook" },
  { route: "src/app/api/webhooks/telegram/route.ts", source: "telegram-webhook" },
];

/**
 * "Please redeliver this" is a deliberate answer, and it has to look like one.
 *
 * `InboundBotEventLeasedError` was thrown OUTSIDE the surrounding try on all three
 * webhooks, and the batched routes then re-threw a failed message's error the same
 * way. Both escaped the route as unhandled rejections. The provider does redeliver
 * — any non-2xx makes it — but nothing reached ErrorLog, the platform recorded a
 * crashed invocation, and a run of unexplained 500s is what gets a Meta/WhatsApp
 * subscription disabled.
 */

test("every inbound webhook answers its retry signals deliberately", () => {
  for (const { route, source } of WEBHOOKS) {
    const code = src(route);
    assert.match(code, /import \{ inboundRetryResponse \} from "@\/lib\/webhookRetry";/, `${route} does not handle its retry signal`);
    assert.match(
      code,
      new RegExp(`catch \\(error\\) \\{\\s*return inboundRetryResponse\\("${source}", error\\);`),
      `${route} must convert an escaping retry signal into a response`,
    );
  }
});

test("the signal cannot escape: every throw site is inside the handled region", () => {
  for (const { route } of WEBHOOKS) {
    const code = src(route);
    const handlerAt = code.indexOf("return inboundRetryResponse");
    // The guard opens at the last bare `try {` line before the handler — the inline
    // `try { body = JSON.parse(...) }` above it is a different, complete statement.
    const guardAt = code.lastIndexOf("\n  try {\n", handlerAt) >= 0
      ? code.lastIndexOf("\n  try {\n", handlerAt)
      : code.lastIndexOf("\n    try {\n", handlerAt);
    assert.ok(guardAt > 0 && handlerAt > guardAt, `${route} has no guarded region around its batch`);

    for (const marker of ["throw new InboundBotEventLeasedError", "throw error;"]) {
      let at = code.indexOf(marker);
      while (at !== -1) {
        assert.ok(at > guardAt && at < handlerAt, `${route}: \`${marker}\` at ${at} is outside the guarded region`);
        at = code.indexOf(marker, at + 1);
      }
    }
  }
});

test("a leased event is answered 503 with Retry-After; a real failure keeps its 500", () => {
  const helper = src("src/lib/webhookRetry.ts");
  // Leased is transient BY CONSTRUCTION — another attempt holds it and the lease
  // expires — so 503 + Retry-After is the accurate status, and it is the one least
  // likely to be counted against the subscription as a server fault.
  assert.match(helper, /error instanceof InboundBotEventLeasedError/);
  assert.match(helper, /status: 503, headers: \{ "Retry-After": "10" \}/);
  // A processing failure is not known to be transient. Changing that status is not
  // this fix's business, so it stays the 500 these routes already returned.
  assert.match(helper, /status: 500/);
  // Both must be visible to the operator; the whole point is that they were not.
  assert.equal((helper.match(/await logError\(source,/g) ?? []).length, 2);
});

test("the batch is not continued past a message we could not finish", () => {
  // A provider batch carries consecutive messages from one customer. Processing the
  // siblings of a failed message would answer their second question before the
  // first, and the redelivery replays the whole batch in order regardless.
  for (const route of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/meta/route.ts"]) {
    const code = src(route);
    const perMessageCatch = code.slice(code.indexOf("await retryInboundBotEvent(claim, error)"));
    assert.match(perMessageCatch.slice(0, 400), /throw error;/, `${route} must abort the batch, not continue it`);
    assert.doesNotMatch(perMessageCatch.slice(0, 400), /\n\s+continue;/, `${route} must not skip past a failed message`);
  }
});
