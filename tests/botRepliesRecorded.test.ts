import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

<<<<<<< HEAD
=======
/**
 * THE BOT MAY NOT TALK TO A CUSTOMER OFF THE RECORD.
 *
 * runDmFlow answered every inbound Messenger and Instagram DM, sent through the
 * Page's own token — so the customer saw it — and wrote NOTHING to Communication.
 * Staff opening that thread saw the customer's messages and their own, with no
 * sign the assistant had already replied. That includes the aiReply path, whose
 * text nobody here wrote or reviewed.
 *
 * It surfaced from the other end on 2026-08-08: a customer received two hostile
 * messages that appeared nowhere in the CRM. The bot turned out to be disabled, so
 * those came from somewhere else — but the investigation is what found this, and
 * "the CRM cannot prove what it did or did not send" is exactly the position not
 * to be in when that question is asked.
 *
 * WHERE THE GUARANTEE NOW LIVES. The bot no longer sends from runDmFlow or
 * runWhatsAppFlow at all. Both write their replies into the durable outbox inside
 * the same transaction that advances the flow, and the outbox worker is the only
 * thing that talks to a provider. The parity these tests defend is therefore
 * structural rather than duplicated — ONE sender, ONE recorder — so the assertions
 * moved to it instead of being deleted.
 *
 * It is also strictly stronger than the shape it replaces. Send-then-log could not
 * survive a process dying between the two: the customer had the message and the
 * CRM did not. A sent row now carries `communicationLoggedAt`, and a sweep repairs
 * any row that sent without logging.
 */

>>>>>>> origin/agent/bot-approved-knowledge
/** A function body, brace-matched from its declaration. */
function functionBody(code: string, declaration: string): string {
  const start = code.indexOf(declaration);
  assert.ok(start !== -1, `could not find ${declaration}`);
  // The body's opening brace is the one that ENDS ITS LINE. Taking the first `{`
  // instead lands inside a return type like `Promise<{ ok: boolean }>`, and the
  // extracted "body" is then only the signature — every assertion against it
  // would pass or fail for the wrong reason.
  const offset = code.slice(start).search(/\{[ \t]*\r?\n/);
  assert.ok(offset !== -1, `could not find the body of ${declaration}`);
  const open = start + offset;
  let depth = 1;
  let i = open + 1;
  for (; i < code.length && depth > 0; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
  }
  return code.slice(start, i);
}

test("the extractor stops at the function's own end", () => {
  const sample = "function a() {\n if (x) { y(); }\n}\nfunction b() { NOT_IN_A(); }\n";
  const body = functionBody(sample, "function a(");
  assert.match(body, /y\(\)/);
  assert.doesNotMatch(body, /NOT_IN_A/);
});

<<<<<<< HEAD
test("channel runners persist replies before asking the durable outbox to deliver", () => {
  for (const [file, declaration, directSend] of [
    ["src/lib/flowDm.ts", "export async function runDmFlow", /sendDirect(Message|Attachment|QuickReplies)\(/],
    ["src/lib/flowRun.ts", "export async function runWhatsAppFlow", /sendWhatsApp(Text|Image|Buttons|List)\(/],
  ] as const) {
    const body = functionBody(src(file), declaration);
    const actor = body.indexOf("await resolveTenantActor()");
    const enqueue = body.indexOf("await enqueueBotMessagesTx(");
    const flush = body.indexOf("await flushBotOutboxConversation(");

    assert.ok(actor >= 0, `${file}: must resolve the actor before accepting outbound work`);
    assert.ok(enqueue > actor, `${file}: must persist outbound work after resolving its actor`);
    assert.ok(flush > enqueue, `${file}: must not deliver before the durable rows exist`);
    assert.match(body, /actorId: actor\.id/, `${file}: every durable reply needs an attributable timeline actor`);
    assert.doesNotMatch(body, directSend, `${file}: provider sends belong only in the durable worker`);
  }
});

test("the durable worker records accepted provider messages on the CRM timeline", () => {
  const code = src("src/lib/botOutbox.ts");
  const sender = code;
  const delivery = functionBody(code, "async function deliverClaimed");
  const recorder = functionBody(code, "async function repairCommunicationLog");

  assert.match(sender, /sendDirect(Message|Attachment|QuickReplies)\(/, "DM delivery must use the shared worker");
  assert.match(sender, /sendWhatsApp(Text|Image|Buttons|List)\(/, "WhatsApp delivery must use the shared worker");

  const accepted = delivery.indexOf('data: { status: "sent", sentAt: new Date()');
  const recorded = delivery.indexOf("await repairCommunicationLog", accepted);
  assert.ok(accepted >= 0 && recorded > accepted, "only provider-accepted messages may reach timeline repair");

  assert.match(recorder, /prisma\.communication\.upsert/);
  assert.match(recorder, /direction: "outbound"/);
  assert.match(recorder, /type: row\.channel/, "each reply must be filed under its provider channel");
  assert.match(recorder, /subject: FLOW_MARKER/, "the inbox needs one shared bot marker");
  assert.match(recorder, /dedupeKey = `bot-outbox:\$\{row\.id\}`/, "timeline repair must be idempotent");
=======
test("the extractor is not fooled by a brace in the return type", () => {
  const sample = "async function f(x: number): Promise<{ ok: boolean }> {\n  REAL_BODY();\n}\n";
  assert.match(functionBody(sample, "async function f("), /REAL_BODY/);
});

test("nothing reaches a customer except through the outbox", () => {
  // A direct provider call in a flow runner would bypass the record entirely.
  for (const rel of ["src/lib/flowDm.ts", "src/lib/flowRun.ts"]) {
    const code = src(rel);
    assert.doesNotMatch(code, /await sendDirect(Message|Attachment|QuickReplies)\(/, `${rel} must not send directly`);
    assert.doesNotMatch(code, /await sendWhatsApp(Text|Image|Buttons|List)\(/, `${rel} must not send directly`);
    assert.match(code, /enqueueBotMessagesTx\(/, `${rel} must enqueue instead`);
  }
});

test("every kind the bot can send is a kind the outbox can record", () => {
  // The old test counted sends against logs inside one function. With a single
  // sender it becomes a coverage question: any message shape sendProvider can
  // deliver, timelineBody must be able to render — otherwise a delivered message
  // has nothing to write down.
  const code = src("src/lib/botOutbox.ts");
  const send = functionBody(code, "async function sendProvider");
  const render = functionBody(code, "function timelineBody");
  for (const kind of ["text", "image"]) {
    assert.ok(send.includes(`"${kind}"`), `sendProvider must handle ${kind}`);
    assert.ok(render.includes(`"${kind}"`), `timelineBody must render ${kind}`);
  }
  assert.ok(send.includes("message.options"), "sendProvider must handle a choice");
  assert.ok(render.includes("message.options"), "timelineBody must render a choice");
  for (const channel of ["whatsapp", "messenger", "instagram", "telegram"]) {
    assert.ok(send.includes(`"${channel}"`), `sendProvider must handle ${channel}`);
  }
});

test("a record is written only after the send reported success", () => {
  // A row for a message the provider rejected is a different lie in the same place.
  const deliver = functionBody(src("src/lib/botOutbox.ts"), "async function deliverClaimed");
  const fail = deliver.indexOf("failDelivery");
  const log = deliver.indexOf("repairCommunicationLog");
  assert.ok(fail !== -1 && log !== -1, "delivery must both fail closed and record");
  assert.ok(fail < log, "a rejected send must return before anything is recorded");
  assert.match(deliver, /status: "sent"/);
});

test("the recorder writes an outbound Communication on the right channel", () => {
  const body = functionBody(src("src/lib/botOutbox.ts"), "async function repairCommunicationLog");
  assert.match(body, /prisma\.communication\.upsert/);
  assert.match(body, /direction: "outbound"/);
  assert.match(body, /type: row\.channel/, "each channel must file under its own name");
  assert.match(body, /subject: FLOW_MARKER/, "so the inbox can tell a bot reply from a person's");
});

test("all channels record through one recorder and share one marker", () => {
  // Parity is the property. It used to need two implementations kept in step;
  // there is now one, which is the stronger version of the same thing.
  const code = src("src/lib/botOutbox.ts");
  const body = functionBody(code, "async function repairCommunicationLog");
  assert.match(body, /\["whatsapp", "messenger", "instagram"\]/, "every recorded channel in one list");

  // Exactly one definition anywhere. Two spellings would split the inbox's idea
  // of "a bot said this", and only one of them would be filtered.
  const defs = ["src/lib/botOutbox.ts", "src/lib/flowDm.ts", "src/lib/flowRun.ts"]
    .filter((rel) => /FLOW_MARKER = /.test(src(rel)));
  assert.deepEqual(defs, ["src/lib/botOutbox.ts"], "the marker must be defined once, with the recorder");
});

test("the AI reply path is inside the recorded loop", () => {
  // The reply this matters most for: aiReply generates text nobody here wrote, and
  // it reaches the customer through the same messages collection. If it ever gets
  // its own send path, this test is where that shows up.
  const body = functionBody(src("src/lib/flowDm.ts"), "export async function runDmFlow");
  assert.match(body, /aiReply:/, "the AI path lives in this function");
  assert.doesNotMatch(body, /await sendDirect/, "any send here would be outside the outbox");
});

test("neither bot speaks before it can record", () => {
  // Unchanged in substance: the actor is resolved BEFORE anything is queued, and a
  // runner with no actor stays quiet rather than talking to a customer untraceably.
  for (const file of ["src/lib/flowDm.ts", "src/lib/flowRun.ts"]) {
    const code = src(file);
    const resolve = code.indexOf("await resolveTenantActor()");
    const enqueue = code.indexOf("await enqueueBotMessagesTx(");
    assert.ok(resolve !== -1, `${file}: must resolve an actor`);
    assert.ok(enqueue !== -1, `${file}: must enqueue something`);
    assert.ok(resolve < enqueue, `${file}: the actor must be resolved BEFORE the reply is queued`);
    assert.match(code, /refusing to reply on/, `${file}: refusal must be visible, not silent`);
  }
});

test("a message that sent but did not record is repaired, not forgotten", () => {
  // The failure send-then-log could not survive: the process dies after the
  // provider accepted and before the Communication was written.
  const code = src("src/lib/botOutbox.ts");
  const sweep = functionBody(code, "async function repairPendingCommunicationLogs");
  assert.match(sweep, /status: "sent", communicationLoggedAt: null/, "the sweep must find exactly those rows");
  assert.match(src("prisma/bot-outbox.prisma"), /communicationLoggedAt DateTime\?/, "and the column must exist to find them by");

  const logger = functionBody(code, "async function repairCommunicationLog");
  assert.doesNotMatch(logger, /if \(!\w+\) return;/, "the logger must not bail out silently");
  assert.match(logger, /userId: row\.actorId/, "the actor comes from the durable row, not a post-hoc lookup");
  assert.doesNotMatch(logger, /resolveTenantActor/, "and is never resolved after the send");
});

/**
 * The parent branch restated the same guarantee at a coarser grain while this
 * branch was splitting it into the cases above. Both are kept: these two pin
 * ordering and attribution INSIDE each runner's own body (the checks above scan
 * the whole file), which is the stricter reading of the same property.
 */

test("channel runners persist replies before asking the durable outbox to deliver", () => {
  for (const [file, declaration, directSend] of [
    ["src/lib/flowDm.ts", "export async function runDmFlow", /sendDirect(Message|Attachment|QuickReplies)\(/],
    ["src/lib/flowRun.ts", "export async function runWhatsAppFlow", /sendWhatsApp(Text|Image|Buttons|List)\(/],
  ] as const) {
    const body = functionBody(src(file), declaration);
    const actor = body.indexOf("await resolveTenantActor()");
    const enqueue = body.indexOf("await enqueueBotMessagesTx(");
    const flush = body.indexOf("await flushBotOutboxConversation(");

    assert.ok(actor >= 0, `${file}: must resolve the actor before accepting outbound work`);
    assert.ok(enqueue > actor, `${file}: must persist outbound work after resolving its actor`);
    assert.ok(flush > enqueue, `${file}: must not deliver before the durable rows exist`);
    assert.match(body, /actorId: actor\.id/, `${file}: every durable reply needs an attributable timeline actor`);
    assert.doesNotMatch(body, directSend, `${file}: provider sends belong only in the durable worker`);
  }
>>>>>>> origin/agent/bot-approved-knowledge
});

test("the durable worker records accepted provider messages on the CRM timeline", () => {
  const code = src("src/lib/botOutbox.ts");
  const sender = code;
  const delivery = functionBody(code, "async function deliverClaimed");
  const recorder = functionBody(code, "async function repairCommunicationLog");

  assert.match(sender, /sendDirect(Message|Attachment|QuickReplies)\(/, "DM delivery must use the shared worker");
  assert.match(sender, /sendWhatsApp(Text|Image|Buttons|List)\(/, "WhatsApp delivery must use the shared worker");

  const accepted = delivery.indexOf('data: { status: "sent", sentAt: new Date()');
  const recorded = delivery.indexOf("await repairCommunicationLog", accepted);
  assert.ok(accepted >= 0 && recorded > accepted, "only provider-accepted messages may reach timeline repair");

  assert.match(recorder, /prisma\.communication\.upsert/);
  assert.match(recorder, /direction: "outbound"/);
  assert.match(recorder, /type: row\.channel/, "each reply must be filed under its provider channel");
  assert.match(recorder, /subject: FLOW_MARKER/, "the inbox needs one shared bot marker");
  assert.match(recorder, /dedupeKey = `bot-outbox:\$\{row\.id\}`/, "timeline repair must be idempotent");
});
