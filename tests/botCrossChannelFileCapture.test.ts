import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const ctx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

test("captureFile stores the channel-provided persisted ref and advances", async () => {
  const flow: Flow = {
    start: "file",
    nodes: {
      file: { id: "file", type: "captureFile", text: "Send a photo", variable: "damage_photo", next: "done" },
      done: { id: "done", type: "message", text: "Received {{damage_photo}}", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const first = await runFlow(flow, { nodeId: null, vars: {} }, { text: "" }, ctx);
  assert.equal(first.session?.nodeId, "file");

  const second = await runFlow(flow, first.session!, { text: "", fileUrl: "stored/ref.jpg" }, ctx);
  assert.equal(second.session, null);
  assert.equal(second.messages[0]?.type, "text");
  assert.match(second.messages[0]?.type === "text" ? second.messages[0].text : "", /stored\/ref\.jpg/);
});

test("Meta runs the flow for attachment-only messages using the persisted CRM attachment", () => {
  const code = src("src/app/api/webhooks/meta/route.ts");
  assert.match(code, /await recordInboundDm\(platform, senderId, text, referral, attachments\)/);
  assert.match(code, /latestPersistedDmAttachment\(platform, senderId, receivedAfter\)/);
  assert.match(code, /if \(text \|\| payload \|\| fileUrl\) await runDmFlow\(platform, senderId, text, payload, fileUrl\)/);
  assert.doesNotMatch(code, /runDmFlow\([^\n]+attachments\[0\]\.url/, "temporary Meta CDN URLs must not become flow variables");
});

test("Telegram resolves file ids to bounded persisted storage before flow execution", () => {
  const transport = src("src/lib/telegramTransport.ts");
  assert.match(transport, /INBOUND_FILE_MAX_BYTES = 20 \* 1024 \* 1024/);
  assert.match(transport, /getFile/);
  assert.match(transport, /saveFile\(buffer, fileName, mimeType\)/);
  assert.match(transport, /total > INBOUND_FILE_MAX_BYTES/);

  const webhook = src("src/app/api/webhooks/telegram/route.ts");
  assert.match(webhook, /tgPersistInboundFile/);
  assert.match(webhook, /runTelegramFlow\(chatId, text, undefined, fileUrl\)/);
});

test("the channel adapters pass persisted fileUrl into the shared FlowInput", () => {
  assert.match(src("src/lib/flowDm.ts"), /\{ text, choiceId: payload, fileUrl \}/);
  assert.match(src("src/lib/telegram.ts"), /\{ text, choiceId: callbackData, fileUrl \}/);
});
