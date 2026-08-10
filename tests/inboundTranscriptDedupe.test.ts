import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inboundCommunicationKey } from "../src/lib/inboundMessageKey";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The inbound ledger deliberately RELEASES its lease when webhook work throws, so
 * the provider redelivers. That is correct, and the projection has to tolerate it.
 *
 * It did not: recordInboundWhatsApp / recordInboundDm created a fresh
 * Communication with no provider identity, so every redelivery added the
 * customer's message again. On WhatsApp that is worse than a cosmetic duplicate —
 * the AI's conversation history is rebuilt from Communication, so a replayed row
 * also distorts what the model is answering.
 */

test("the same provider event always derives the same key", () => {
  assert.equal(inboundCommunicationKey("whatsapp", "wamid.ABC"), "whatsapp:wamid.ABC");
  assert.equal(
    inboundCommunicationKey("whatsapp", "wamid.ABC"),
    inboundCommunicationKey("whatsapp", " wamid.ABC "),
    "whitespace must not create a second identity for one message",
  );
});

test("different events, channels and attachments never collide", () => {
  const keys = [
    inboundCommunicationKey("whatsapp", "m1"),
    inboundCommunicationKey("whatsapp", "m2"),
    inboundCommunicationKey("messenger", "m1"),
    inboundCommunicationKey("instagram", "m1"),
    inboundCommunicationKey("instagram", "m1", 0),
    inboundCommunicationKey("instagram", "m1", 1),
  ];
  assert.equal(new Set(keys).size, keys.length, `keys collided: ${keys.join(", ")}`);
  // One provider message can produce several attachment rows; each needs its own.
  assert.equal(inboundCommunicationKey("instagram", "m1", 0), "instagram:m1:attachment:0");
});

test("a missing provider id yields no key rather than a colliding one", () => {
  // A key of "whatsapp:" would fold EVERY unidentified message on that channel
  // into a single row and lose the transcript. Writing un-keyed risks a
  // duplicate, which is the lesser failure — and it is deliberate, not an oversight.
  assert.equal(inboundCommunicationKey("whatsapp", ""), null);
  assert.equal(inboundCommunicationKey("whatsapp", "   "), null);
});

test("both projections write keyed rows and can tell a replay from a first delivery", () => {
  for (const [rel, fn] of [
    ["src/lib/whatsapp.ts", "recordInboundWhatsApp"],
    ["src/lib/messenger.ts", "recordInboundDm"],
  ] as const) {
    const code = src(rel);
    assert.match(code, /inboundCommunicationKey\(/, `${rel}: must derive a dedupe key`);
    // createMany + skipDuplicates rather than create: it reports whether the row
    // was actually written, which is what decides the push.
    assert.match(code, /skipDuplicates: true/, `${rel}: a replay must not insert a second row`);
    assert.match(code, /count === 0/, `${rel}: must detect the replay`);
    assert.ok(code.includes(`export async function ${fn}`), `${rel}: ${fn} must exist`);
  }
});

test("a replayed delivery does not notify everyone a second time", () => {
  // The duplicate push is the same defect wearing a different hat, and it is the
  // half a person actually notices.
  for (const rel of ["src/lib/whatsapp.ts", "src/lib/messenger.ts"]) {
    const code = src(rel);
    const guard = code.indexOf("if (replayed) return;");
    const push = code.indexOf("sendPushToAll", guard === -1 ? 0 : guard);
    assert.ok(guard !== -1, `${rel}: must bail out on a replay`);
    assert.ok(push > guard, `${rel}: the bail-out must come BEFORE the notification`);
  }
});

test("every webhook hands its provider message id to the projection", () => {
  // Without the id the projection cannot key the row, and the ledger's redelivery
  // becomes a duplicate again.
  const whatsapp = src("src/app/api/webhooks/whatsapp/route.ts");
  const calls = whatsapp.match(/recordInboundWhatsApp\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 4, `expected every WhatsApp message type, found ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /message\.id/, `a WhatsApp projection call has no provider id: ${call}`);
  }
  assert.match(src("src/app/api/webhooks/meta/route.ts"), /recordInboundDm\([^)]*ev\.message\?\.mid/);
});
