import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";
import { validateFlow } from "../src/lib/flowValidation";
import { contactCardText, documentFallbackText, whatsappContactsMessage } from "../src/lib/flowMedia";
import { matchQrCode, parseQrCodes, qrLink, qrSource } from "../src/lib/flowQr";

const card = { name: "Denago Cape Town", organization: "Denago Cape Town", phones: ["+27 21 000 0000"], email: "sales@example.com", website: "https://example.com" };

function ctx(overrides: Partial<FlowCtx> = {}): FlowCtx {
  return {
    aiReply: async () => ({ reply: "AI", handoff: false }),
    dynamicAnswer: async () => "dynamic",
    createBooking: async () => ({ ok: true }),
    handoff: async () => {},
    ...overrides,
  };
}

const pack: Flow = { start: "doc", nodes: {
  doc: { id: "doc", type: "document", documentId: "d1", fileName: "Brochure.pdf", caption: "Hi {{name}}", next: "card" },
  card: { id: "card", type: "contactCard", next: "end" },
  end: { id: "end", type: "end" },
} };

test("a brochure flow sends the document then the contact card", async () => {
  const result = await runFlow(pack, { nodeId: null, vars: { name: "Ann" } }, { text: "" }, ctx({ contactCard: async () => card }));
  assert.deepEqual(result.messages, [
    { type: "document", documentId: "d1", fileName: "Brochure.pdf", caption: "Hi Ann" },
    { type: "contact", card },
  ]);
});

test("no contact card configured: nothing sent, the flow carries on", async () => {
  const result = await runFlow(pack, { nodeId: null, vars: {} }, { text: "" }, ctx({ contactCard: async () => null }));
  assert.deepEqual(result.messages.map((m) => m.type), ["document"]);
});

test("a document step without a file is an error", () => {
  const flow: Flow = { start: "doc", nodes: { doc: { id: "doc", type: "document", documentId: "", next: "end" }, end: { id: "end", type: "end" } } };
  assert.ok(validateFlow(flow).some((issue) => issue.code === "document.missing" && issue.severity === "error"));
});

test("WhatsApp contact message has the shape Meta requires", () => {
  const body = whatsappContactsMessage("27820000000", card) as { type: string; contacts: Array<Record<string, unknown>> };
  assert.equal(body.type, "contacts");
  assert.deepEqual(body.contacts[0].name, { formatted_name: "Denago Cape Town", first_name: "Denago Cape Town" });
  assert.deepEqual(body.contacts[0].phones, [{ phone: "+27 21 000 0000", type: "WORK" }]);
  assert.match(contactCardText(card), /📞 \+27 21 000 0000/);
});

test("channels without files get the name, never a link", () => {
  const text = documentFallbackText("Brochure.pdf", undefined);
  assert.match(text, /Brochure\.pdf/);
  assert.doesNotMatch(text, /https?:/);
});

test("QR link, saved list and inbound match", () => {
  assert.equal(qrLink("+27 82 000 0000", " Hi, send the brochure "), "https://wa.me/27820000000?text=Hi%2C%20send%20the%20brochure");
  const codes = parseQrCodes(JSON.stringify([{ routeId: "r1", name: "Show stand", message: "Hi Denago, please send me the brochure" }, { bad: true }]));
  assert.equal(codes.length, 1);
  assert.deepEqual(parseQrCodes("not json"), []);
  assert.equal(matchQrCode(codes, "Hi Denago, please send me the brochure")?.routeId, "r1");
  assert.equal(matchQrCode(codes, "hello"), null);
  assert.equal(qrSource(" Show stand "), "QR code — Show stand");
});

test("flow documents are workspace-scoped, general files only; QR edits are owner-only", () => {
  const docs = readFileSync("src/lib/flowDocuments.ts", "utf8");
  assert.match(docs, /return \{ tenantId, deletedAt: null, contactId: null/);
  const actions = readFileSync("src/app/actions/flow.ts", "utf8");
  const add = actions.slice(actions.indexOf("export async function addFlowQr"), actions.indexOf("export async function deleteFlowQr"));
  assert.match(add, /owner/i);
  assert.match(add, /kind: "keyword"/);
});
