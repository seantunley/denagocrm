import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

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
  const sample = "function a() {\n if (x) { y(); }\n}\nfunction b() { NOT_IN_A(); }\n";
  const body = functionBody(sample, "function a(");
  assert.match(body, /y\(\)/);
  assert.doesNotMatch(body, /NOT_IN_A/);
});

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
});
