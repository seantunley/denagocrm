import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_INSTRUCTIONS, QUOTE_BUILD_MAX_LINES, QUOTE_BUILD_RULE, parseActionList, quoteBuildText } from "../src/lib/assistantActions";

/*
 * DAX builds a quote (Sean, 2026-10-12: "DAX must be able to generate a quote
 * for a customer, asking all the questions and deliver the PDF to WhatsApp, but
 * NEVER send to customer").
 *
 * What has to hold:
 *  - it asks for what it does not know, and prices come from the catalogue only;
 *  - confirming creates a DRAFT — never sent, emailed or put out for signature;
 *  - the PDF goes to the member of staff who asked, never to the customer
 *    (the delivery itself is run against fakes in assistantWhatsAppConfirm.test.ts).
 */

const code = (rel: string) => readFileSync(rel, "utf8");
const LEAD = "cmabcdefghijklmnopqrstuv";
const PRODUCT = "cmproductabcdefghijklmno";

test("the task: catalogue products and quantities — and no way to carry a price", () => {
  const ok = { type: "quote_build", leadId: LEAD, lines: [{ productId: PRODUCT, qty: 2, discountPct: 5, colour: "White" }] };
  assert.equal(parseActionList([ok]).length, 1);
  // A price, a description or a customer address on the task is refused outright (strict), not ignored.
  for (const extra of [{ unitPriceCents: 100 }, { price: 1 }, { description: "Special" }]) {
    assert.equal(parseActionList([{ ...ok, lines: [{ ...ok.lines[0], ...extra }] }]).length, 0, JSON.stringify(extra));
  }
  for (const extra of [{ to: "27821234567" }, { email: "x@example.test" }, { send: true }, { status: "sent" }]) {
    assert.equal(parseActionList([{ ...ok, ...extra }]).length, 0, JSON.stringify(extra));
  }
  // Bounds.
  assert.equal(parseActionList([{ ...ok, lines: [] }]).length, 0, "at least one line");
  assert.equal(parseActionList([{ ...ok, lines: Array.from({ length: QUOTE_BUILD_MAX_LINES + 1 }, () => ok.lines[0]) }]).length, 0);
  for (const qty of [0, -1, 1.5, 501]) assert.equal(parseActionList([{ ...ok, lines: [{ productId: PRODUCT, qty }] }]).length, 0, `qty ${qty}`);
  for (const discountPct of [-1, 101]) assert.equal(parseActionList([{ ...ok, lines: [{ productId: PRODUCT, qty: 1, discountPct }] }]).length, 0);
});

test("what the person reads before confirming: every line at its catalogue price, the discount said, and that it is a draft", () => {
  const money = (cents: number) => `R ${(cents / 100).toFixed(2)}`;
  assert.equal(
    quoteBuildText([
      { productId: "p1", description: "Rover XL", qty: 1, unitPriceCents: 24990000, discountPct: 0 },
      { productId: "p2", description: "Nomad", qty: 2, unitPriceCents: 23400000, discountPct: 5, colour: "White" },
    ], money),
    "1 × Rover XL — R 249900.00 each\n2 × Nomad (White) — R 234000.00 each, less 5%\nCatalogue prices. Created as a DRAFT — it is not sent to the customer.",
  );
});

test("DAX is told to ask first, to use the catalogue only, and never to offer sending it to the customer", () => {
  assert.ok(ACTION_INSTRUCTIONS.includes(QUOTE_BUILD_RULE));
  assert.match(ACTION_INSTRUCTIONS, /\{"type":"quote_build","leadId":"<id>","lines":\[\{"productId":"<id>","qty":1,"discountPct":0,"colour":"<optional>"\}\]\}/);
  assert.match(QUOTE_BUILD_RULE, /ASK FIRST for everything you do not have, all in one message: which customer[^.]*which product\(s\), how many of each, any discount[^.]*and the colour/);
  assert.match(QUOTE_BUILD_RULE, /Products come ONLY from the catalogue/);
  assert.match(QUOTE_BUILD_RULE, /The price is always the catalogue's: never put a price in the task/);
  assert.match(QUOTE_BUILD_RULE, /the PDF comes back to THEM on WhatsApp/);
  assert.match(QUOTE_BUILD_RULE, /It is NEVER sent to the customer and never marked sent: do not offer to send it, email it or WhatsApp it to the customer/);
});

test("the card is built from the CATALOGUE as the workspace has it, for someone who may create quotes", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const at = lib.indexOf('} else if (p.type === "quote_build") {');
  const build = lib.slice(at, lib.indexOf("return cards;", at));
  assert.ok(at > 0);
  assert.match(build, /if \(!lead\.contactId \|\| !\(await hasPermission\(user, "quotes\.create"\)\)\) continue;/);
  // The workspace's own client, products on sale only; an unknown id drops the whole card.
  assert.match(build, /await prisma\.product\.findMany\(\{\s*where: \{ id: \{ in: [^}]*\}, active: true, deletedAt: null \},/);
  assert.match(build, /if \(p\.lines\.some\(\(line\) => !byId\.has\(line\.productId\)\)\) continue;/);
  // The price on the card is the product's, not anything from the proposal.
  assert.match(build, /unitPriceCents: product\.basePriceCents/);
  assert.match(build, /description: product\.name/);
});

test("CONFIRM CREATES A DRAFT AND NOTHING ELSE: catalogue re-read, stale prices refused, never sent", () => {
  const actions = code("src/app/actions/assistant.ts");
  const at = actions.indexOf('case "quote_build": {');
  const run = actions.slice(at, actions.indexOf("default:", at));
  assert.ok(at > 0);
  // Turned away BEFORE anything is written when the card no longer matches the world.
  assert.match(run, /if \(!lead\.contactId \|\| lead\.contactId !== card\.contactId\) return untouched\(STALE_CARD\);/);
  assert.match(run, /where: \{ id: \{ in: [^}]*\}, active: true, deletedAt: null \}/);
  assert.match(run, /if \(lines\.some\(\(line\) => byId\.get\(line\.productId\)\?\.basePriceCents !== line\.unitPriceCents\)\) \{\s*return untouched\(/);
  assert.ok(run.indexOf("return untouched(\"The catalogue changed") < run.indexOf("await saveQuoteDraft("), "checked before the save");
  // Saved through the editor's own save, as a draft, at the catalogue's price and name.
  assert.match(run, /intent: "draft",/);
  assert.match(run, /description: product\.name, qty: line\.qty, unitPriceCents: product\.basePriceCents, productId: product\.id,/);
  assert.doesNotMatch(run, /intent: "sent"|status: "sent"|setQuoteStatus|markQuoteSentIfDraft|sendQuoteEmail|sendEmail|sendWhatsApp|dispatchRequest|createSignatureRequest/);
  assert.match(run, /It has NOT been sent to the customer\./);
});

test("DAX CAN NAME A CATALOGUE PRODUCT: the knowledge tool gives it each product's id", () => {
  // Review of #872 (blocker): knowledge() fetched the ids and left them out of what the
  // assistant is shown. It knew "Rover XL" and its price, had no id to put in the task,
  // and an invented one fails the catalogue check — the quote was silently dropped.
  const lib = code("src/lib/crmAssistant.ts");
  const at = lib.indexOf("async function knowledge(");
  const tool = lib.slice(at, lib.indexOf("\n}\n", at));
  assert.ok(at > 0);
  assert.match(tool, /select: \{ id: true, name: true, category: true, basePriceCents: true,/);
  assert.match(tool, /products: relevant\.map\(\(p\) => \(\{[\s\S]{0,420}productId: p\.id,\s*product: p\.name,/);
  // …and that is the name the task and the rule use for it.
  assert.match(QUOTE_BUILD_RULE, /use the product's id as productId/);
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ productId: PRODUCT, qty: 1 }] }]).length, 1);
  // The card builder accepts exactly such an id — read from the same catalogue, on sale only.
  const build = lib.slice(lib.indexOf('} else if (p.type === "quote_build") {'));
  assert.match(build, /where: \{ id: \{ in: \[\.\.\.new Set\(p\.lines\.map\(\(line\) => line\.productId\)\)\] \}, active: true, deletedAt: null \}/);
});

test("THE PDF IS QUEUED WITH THE QUOTE — delivered wherever Confirm was pressed, by the delivery that retries", () => {
  // Review of #872: (2) a quote confirmed in the CRM chat sent no PDF to WhatsApp at all;
  // (3) on WhatsApp the task was marked done before the PDF was rendered and sent, so a
  // crash there lost it for good. Both: the action now QUEUES it as an update for the
  // person, straight after the quote is saved, and the assistant's durable sender delivers.
  const actions = code("src/app/actions/assistant.ts");
  const at = actions.indexOf('case "quote_build": {');
  const run = actions.slice(at, actions.indexOf("default:", at));
  const saved = run.indexOf("await saveQuoteDraft(");
  const queued = run.indexOf("source: QUOTE_PDF_SOURCE,");
  assert.ok(saved > 0 && queued > saved, "queued after the quote exists");
  assert.match(run, /userId: user\.id,\s*source: QUOTE_PDF_SOURCE,\s*quoteId: saved\.quote\.id,/);
  // For the signed-in person only: nothing on the card says who it is for.
  assert.doesNotMatch(run.slice(queued - 200, queued + 400), /card\.(userId|to|waId|phone)/);
  // A failure to queue never turns a created quote into an error.
  assert.match(run.slice(queued), /\.catch\(async \(err: unknown\) => \{/);
  // Confirmed in the CRM: this action tries the send, briefly; on WhatsApp the door sends it after its reply.
  assert.match(run, /if \(queued && via === "crm"\) \{/);
  assert.match(run, /sendUpdatesToLinkedPhone\(tenantId, user\.id\)\.catch\(/);
  assert.match(run, /setTimeout\(resolve, QUOTE_PDF_SEND_WAIT_MS\)/);
  assert.match(actions, /via: "crm" \| "whatsapp" = "crm",/);
  // The total the person is told is the QUOTE's own (VAT, discounts), read back from what was saved.
  assert.match(run, /const total = built \? formatZAR\(Math\.round\(payableTotalCents\(built\)\)\) : null;/);

  // It is an update like a briefing: the sweep retries it, and the bubble shows it.
  const rules = code("src/lib/assistantWhatsAppRules.ts");
  assert.match(rules, /export const PROACTIVE_SOURCES = \["schedule", "watch", "handoff", "quote_pdf"\] as const;/);
  const schema = code("prisma/schema.prisma");
  const turnModel = schema.slice(schema.indexOf("model AssistantTurn {"));
  assert.match(turnModel.slice(0, turnModel.indexOf("\n}")), /^\s*quoteId String\?\s*$/m);
  const sql = code("prisma/migrations/20261012150000_assistant_turn_quote_pdf/migration.sql");
  assert.match(sql, /ALTER TABLE "AssistantTurn" ADD COLUMN IF NOT EXISTS "quoteId" TEXT;/);
  // Its statements only (the comments say "update", meaning an assistant update): additive, nothing rewritten.
  assert.doesNotMatch(sql.replace(/^\s*--.*$/gm, ""), /DROP|NOT NULL|\bUPDATE\b|\bDELETE\b/i);
});

test("THE PDF GOES TO THE PERSON WHO ASKED — the only number it can reach is their own verified, re-checked phone", () => {
  const lib = code("src/lib/assistantWhatsApp.ts");
  const at = lib.indexOf("async function sendQuotePdfToStaff(");
  const send = lib.slice(at, lib.indexOf("const OUT_OF_TIME", at));
  assert.ok(at > 0);
  // One caller: the update sender, which has re-verified the link, its sign-in and
  // that the number is on no customer record for THIS send — before any document.
  assert.equal((lib.match(/sendQuotePdfToStaff\(/g) ?? []).length, 2, "one definition, one call");
  const deliver = lib.slice(lib.indexOf("export async function sendUpdatesToLinkedPhone("), lib.indexOf("async function sendOneUpdate("));
  assert.ok(deliver.indexOf("matchByPhone(link.waId)") < deliver.indexOf("sendOneUpdate(tenantId, userId, link.waId, turn, outOfTime)"));
  assert.match(deliver, /if \(customer\.contactId \|\| customer\.leadId \|\| customer\.ambiguous\) return "not_safe";/);
  // The one document send in the module: to `waId`, three arguments — no `record`, so no customer timeline.
  assert.equal((lib.match(/sendWhatsAppDocument\(/g) ?? []).length, 1);
  assert.match(send, /await sendWhatsAppDocument\(waId, \{ content: pdf, filename: quotePdfFileName\(quote\.number\), contentType: "application\/pdf" \}, `Draft quote Q-\$\{quote\.number\} — for you\. Not sent to the customer\.`\)/);
  // Their own quote, in this workspace, still there.
  assert.match(send, /basePrisma\.quote\.findFirst\(\{ where: \{ id: quoteId, tenantId, createdById: userId, deletedAt: null \}, select: \{ id: true, number: true \} \}\)/);
  // It looks up no customer and no other number, and changes nothing about the quote.
  const body = send.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(body, /contact\.|lead\.|\.phone|\.whatsapp|quote\.(update|updateMany|create|delete)|markQuoteSentIfDraft|sendEmail|status:|emailedAt/);
  const renderer = code("src/lib/quotePdf.ts");
  assert.match(renderer, /renderQuotePrintHtml\(\{ quoteId \}\)/);
  // The renderer it uses cannot change a quote: it holds no database client at all.
  assert.doesNotMatch(renderer, /prisma|updateMany|status/);
});

test("in the CRM chat the card shows the same lines before Confirm", () => {
  assert.match(code("src/components/AssistantActionCard.tsx"), /card\.kind === "quote_build" && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">\{card\.text\}<\/p>/);
});
