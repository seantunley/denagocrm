import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * THE BOT MAY NOT TALK TO A CUSTOMER OFF THE RECORD.
 *
 * runDmFlow answers every inbound Messenger and Instagram DM, sends through the
 * Page's own token — so the customer sees it — and wrote NOTHING to
 * Communication. Staff opening that thread saw the customer's messages and their
 * own, with no sign the assistant had already replied. That includes the aiReply
 * path, whose text nobody here wrote or reviewed.
 *
 * It surfaced from the other end on 2026-08-08: a customer received two hostile
 * messages that appeared nowhere in the CRM. The bot turned out to be disabled, so
 * those came from somewhere else — but the investigation is what found this, and
 * "the CRM cannot prove what it did or did not send" is exactly the position not
 * to be in when that question is asked.
 *
 * The WhatsApp bot has always recorded its replies (`logOutbound` in flowRun.ts).
 * The DM channels were simply missing the same call. These tests pin the parity.
 */

/** A function body, brace-matched from its declaration. */
function functionBody(code: string, declaration: string): string {
  const start = code.indexOf(declaration);
  assert.ok(start !== -1, `could not find ${declaration}`);
  const open = code.indexOf("{", start);
  let depth = 1;
  let i = open + 1;
  for (; i < code.length && depth > 0; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
  }
  return code.slice(start, i);
}

test("the extractor stops at the function's own end", () => {
  // Guard the tool: a body that ran to the end of the file would make every
  // assertion below pass regardless of where the calls actually live.
  const sample = "function a() {\n if (x) { y(); }\n}\nfunction b() { NOT_IN_A(); }\n";
  const body = functionBody(sample, "function a(");
  assert.match(body, /y\(\)/);
  assert.doesNotMatch(body, /NOT_IN_A/);
});

test("every DM send is followed by a record of what was sent", () => {
  const body = functionBody(src("src/lib/flowDm.ts"), "export async function runDmFlow");

  const sends = body.match(/await send(DirectMessage|DirectAttachment|DirectQuickReplies)\(/g) ?? [];
  const logs = body.match(/await logOutboundDm\(/g) ?? [];
  assert.ok(sends.length >= 3, `expected the three DM send kinds, found ${sends.length}`);
  assert.equal(
    logs.length,
    sends.length,
    `${sends.length} sends but ${logs.length} records — a send with no record is a message only the customer can see`,
  );
});

test("a record is written only when the send reported success", () => {
  // A row for a message Meta rejected is a different lie in the same place. Same
  // rule the WhatsApp bot follows.
  const body = functionBody(src("src/lib/flowDm.ts"), "export async function runDmFlow");
  const guarded = body.match(/if \(\w+\.ok\) await logOutboundDm\(/g) ?? [];
  const guardedBlocks = body.match(/if \(\w+\.ok\) \{[\s\S]*?logOutboundDm\(/g) ?? [];
  const logs = body.match(/await logOutboundDm\(/g) ?? [];
  assert.equal(
    guarded.length + guardedBlocks.length,
    logs.length,
    "every logOutboundDm must sit behind an .ok check",
  );
});

test("the recorder writes an outbound Communication on the right channel", () => {
  const body = functionBody(src("src/lib/flowDm.ts"), "async function logOutboundDm");
  assert.match(body, /prisma\.communication\.create/);
  assert.match(body, /direction: "outbound"/);
  assert.match(body, /type: platform/, "messenger and instagram must file under their own channel");
  assert.match(body, /subject: FLOW_MARKER/, "so the inbox can tell a bot reply from a person's");
});

test("both channels' bots record, and share one marker", () => {
  // Parity is the actual property. WhatsApp had it; the DM channels did not, and
  // nothing in the repo compared them.
  const wa = src("src/lib/flowRun.ts");
  const dm = src("src/lib/flowDm.ts");
  assert.match(wa, /async function logOutbound\(/, "the WhatsApp recorder must still exist");
  assert.match(dm, /async function logOutboundDm\(/, "and the DM one");

  // One marker, imported — two spellings would split the inbox's idea of "a bot
  // said this", and only one of them would be filtered.
  assert.match(wa, /export const FLOW_MARKER/, "the marker must be shared, not private");
  assert.match(dm, /import \{ FLOW_MARKER \} from "\.\/flowRun"/);
  assert.doesNotMatch(dm, /FLOW_MARKER = /, "and must not be restated");
});

test("the AI reply path is inside the recorded loop", () => {
  // The reply this matters most for: aiReply generates text nobody here wrote, and
  // it reaches the customer through the same result.messages loop. If it ever gets
  // its own send path, this test is where that shows up.
  const body = functionBody(src("src/lib/flowDm.ts"), "export async function runDmFlow");
  assert.match(body, /aiReply:/, "the AI path lives in this function");
  const sendsOutsideLoop = body.slice(0, body.indexOf("for (const m of result.messages)"));
  assert.doesNotMatch(
    sendsOutsideLoop,
    /await sendDirect/,
    "a send before the recorded loop would be unrecorded again",
  );
});

/**
 * …AND THE RECORD MAY NOT BE OPTIONAL.
 *
 * Review found the first version still allowed the exact thing this PR exists to
 * stop. The logger resolved the tenant actor AFTER the message had gone:
 *
 *   Meta send succeeds
 *     → resolveTenantActor() returns null
 *     → logger returns silently
 *     → customer has the message, CRM has no record
 *
 * The WhatsApp bot had the same weakness, so copying its pattern gave parity and
 * not safety. Both now resolve the actor BEFORE anything is sent and refuse to
 * speak without one: a bot that stays quiet is better than one that talks to a
 * customer with no trace of it.
 */

test("neither bot sends before it can record", () => {
  for (const [file, sendCall] of [
    ["src/lib/flowDm.ts", "await sendDirect"],
    ["src/lib/flowRun.ts", "await sendWhatsApp"],
  ] as const) {
    const code = src(file);
    const resolve = code.indexOf("await resolveTenantActor()");
    const firstSend = code.indexOf(sendCall);
    assert.ok(resolve !== -1, `${file}: must resolve an actor`);
    assert.ok(firstSend !== -1, `${file}: must send something`);
    assert.ok(
      resolve < firstSend,
      `${file}: the actor must be resolved BEFORE the first send, or a send can outlive its record`,
    );
    assert.match(code, /refusing to reply on/, `${file}: refusal must be visible, not silent`);
  }
});

test("the loggers cannot silently skip a record", () => {
  // `if (!actor) return` inside the logger is the defect. The actor is now a
  // required argument, so there is no path where the write is skipped.
  for (const [file, fn] of [
    ["src/lib/flowDm.ts", "async function logOutboundDm"],
    ["src/lib/flowRun.ts", "async function logOutbound"],
  ] as const) {
    const code = src(file);
    const body = functionBody(code, fn);
    assert.doesNotMatch(body, /if \(!\w+\) return;/, `${file}: the logger must not bail out`);
    assert.match(body, /actorId/, `${file}: the actor must be supplied by the caller`);
    assert.doesNotMatch(body, /resolveTenantActor/, `${file}: and not resolved after the send`);
  }
});
