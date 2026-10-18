import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_INSTRUCTIONS, QUOTE_BUILD_MAX_LINES, QUOTE_BUILD_RULE, matchCatalogueProduct, parseActionList, quoteBuildText } from "../src/lib/assistantActions";

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
  // TWO examples, one per id — never one field described as taking either (review of #876:
  // "contactId: <customer id — or leadId…>" invited a deal's id into contactId, where it matched no customer).
  assert.match(ACTION_INSTRUCTIONS, /\{"type":"quote_build","contactId":"<the contactId of a CUSTOMER — a quote for the customer, on no deal>","lines":\[\{"productId":"<id>","qty":1,"discountPct":0,"colour":"<optional>"\}\]\}/);
  assert.match(ACTION_INSTRUCTIONS, /\{"type":"quote_build","leadId":"<the leadId of a DEAL — a quote for that deal; give no contactId>","lines":\[\{"productId":"<id>","qty":1\}\]\}/);
  assert.doesNotMatch(ACTION_INSTRUCTIONS, /"contactId":"[^"]*leadId/, "no example puts a lead id in contactId");
  assert.match(QUOTE_BUILD_RULE, /a contactId goes ONLY in contactId, a leadId ONLY in leadId, and a task gives one of them, not both/);
  assert.match(QUOTE_BUILD_RULE, /ASK FIRST for everything you do not have, all in one message: which customer[^.]*which product\(s\), how many of each, any discount[^.]*and the colour/);
  assert.match(QUOTE_BUILD_RULE, /Products come ONLY from the catalogue/);
  assert.match(QUOTE_BUILD_RULE, /The price is always the catalogue's: never put a price in the task/);
  assert.match(QUOTE_BUILD_RULE, /the PDF comes back to THEM on their linked WhatsApp/);
  assert.match(QUOTE_BUILD_RULE, /It is NEVER sent to the customer and never marked sent: do not offer to send it, email it or WhatsApp it to the customer/);
});

/** The card builder's quote branch: from its `if` to the lead checks that follow it. */
const quoteBranch = () => {
  const lib = code("src/lib/crmAssistant.ts");
  const at = lib.indexOf('if (p.type === "quote_build") {');
  assert.ok(at > 0);
  return lib.slice(at, lib.indexOf("if (!(await canAccessLead(user, p.leadId))) continue;\n    const lead = await prisma.lead.findUnique({", at));
};

test("A QUOTE IS FOR A CUSTOMER — a lead is not required", () => {
  // Sean, 2026-10-12, after DAX answered "I can't set up the draft quote yet because Test
  // Customer has a customer record but no lead": "If any existing customer wants a new
  // quote, it is not a new lead, its existing business." The CRM always allowed it; the
  // first version of this task wrongly insisted on a lead.
  const CONTACT = "cmcontactabcdefghijklmno";
  assert.equal(parseActionList([{ type: "quote_build", contactId: CONTACT, lines: [{ productId: PRODUCT, qty: 1 }] }]).length, 1, "a customer and no lead");
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ productId: PRODUCT, qty: 1 }] }]).length, 1, "or one of their deals");
  // DAX is told so, in as many words.
  assert.match(QUOTE_BUILD_RULE, /A QUOTE IS FOR A CUSTOMER — A LEAD IS NOT REQUIRED\./);
  assert.match(QUOTE_BUILD_RULE, /quote them directly with contactId/);
  assert.match(QUOTE_BUILD_RULE, /Never say a lead is needed, and never tell them to create one first\./);
  assert.doesNotMatch(QUOTE_BUILD_RULE, /say a lead is needed first/);
  // …and so is the lookup that used to tell it only a NOTE could go on a customer with no deal.
  assert.match(code("src/lib/crmAssistant.ts"), /There is no deal to report on — which stops nothing: a quote can be made for the customer directly \(quote_build with the contactId; no lead is needed\)/);

  const build = quoteBranch();
  // Handled before the lead checks, for a deal OR a customer; a task naming neither proposes nothing.
  assert.match(build, /if \(dealId\) \{\s*if \(!\(await canAccessLead\(user, dealId\)\)\) continue;/);
  assert.match(build, /\} else if \(contactId\) \{\s*if \(!\(await canAccessContact\(user, contactId\)\)\) continue;/);
  // An id put in the wrong field is not dropped in silence: a "contactId" that is no customer
  // here is read as a deal — and then checked as a deal, with a deal's own access check.
  assert.match(build, /if \(contactId && !\(await prisma\.contact\.findFirst\(\{ where: \{ id: contactId \}, select: \{ id: true \} \}\)\)\) \{\s*dealId = contactId;\s*contactId = null;/);
  assert.ok(build.indexOf("dealId = contactId;") < build.indexOf("canAccessLead(user, dealId)"));
  assert.match(build, /if \(!customerId\) continue;/);
  assert.match(build, /leadId: forDeal\?\.id \?\? null,/);

  const actions = code("src/app/actions/assistant.ts");
  const run = actions.slice(actions.indexOf('case "quote_build": {'), actions.indexOf('case "quote_pdf": {'));
  // No deal: the customer must still be there; the save then checks this person may quote them.
  assert.match(run, /\} else \{\s*const customer = await prisma\.contact\.findFirst\(\{ where: \{ id: String\(card\.contactId \?\? ""\), deletedAt: null \}, select: \{ id: true \} \}\);\s*if \(!customer\) return untouched\("That customer is no longer there\."\);/);
  assert.match(run, /contactId: card\.contactId,\s*leadId: card\.leadId \?\? null,/);
  // Recorded on the deal when there is one, otherwise on the customer — never on nothing.
  assert.match(run, /\.\.\.\(card\.leadId \? \{ leadId: card\.leadId \} : \{ contactId: card\.contactId \}\),/);
  assert.match(code("src/lib/assistantWhatsAppConfirm.ts"), /\(card\.kind === "quote_build" \|\| card\.kind === "quote_add" \|\| card\.kind === "quote_change"\) && !card\.leadId \? \{ contactId: card\.contactId \} : \{\}/);
  assert.match(code("src/components/AssistantActionCard.tsx"), /\(card\.kind === "quote_build" \|\| card\.kind === "quote_add" \|\| card\.kind === "quote_change"\) && !card\.leadId \? `\/contacts\/\$\{card\.contactId\}`/);
});

test("a product can be named by its catalogue id or its catalogue NAME — and a name must mean exactly one product", () => {
  const catalogue = [
    { id: "p1", name: "Denago Rover XL" },
    { id: "p2", name: "Denago Rover XL Lifted" },
    { id: "p3", name: "Denago EV Nomad" },
    { id: "p4", name: "City Cart" },
  ];
  assert.equal(matchCatalogueProduct(catalogue, { productId: "p3" })?.id, "p3");
  // The exact name, whatever the case or spacing.
  assert.equal(matchCatalogueProduct(catalogue, { product: "  denago   rover xl " })?.id, "p1");
  // A shorter name that only one product contains.
  assert.equal(matchCatalogueProduct(catalogue, { product: "Nomad" })?.id, "p3");
  assert.equal(matchCatalogueProduct(catalogue, { product: "city cart" })?.id, "p4");
  // Two candidates is no match: a guess would put the wrong vehicle on the quote.
  assert.equal(matchCatalogueProduct(catalogue, { product: "Rover" }), null);
  assert.equal(matchCatalogueProduct(catalogue, { product: "Denago" }), null);
  // Not in the catalogue, or nothing given.
  assert.equal(matchCatalogueProduct(catalogue, { product: "Golf Buggy" }), null);
  assert.equal(matchCatalogueProduct(catalogue, {}), null);
  // A made-up id falls back to the name — it used to drop the quote without a word.
  assert.equal(matchCatalogueProduct(catalogue, { productId: "invented", product: "City Cart" })?.id, "p4");
  assert.equal(matchCatalogueProduct(catalogue, { productId: "invented" }), null);
  // The task carries either; a price still cannot ride along.
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ product: "Rover XL", qty: 1 }] }]).length, 1);
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ product: "Rover XL", qty: 1, unitPriceCents: 1 }] }]).length, 0);
});

test("the card is built from the CATALOGUE as the workspace has it, for someone who may create quotes", () => {
  const build = quoteBranch();
  assert.match(build, /if \(!\(await hasPermission\(user, "quotes\.create"\)\)\) continue;/);
  // The workspace's own client, products on sale only; a line that matches no ONE product drops the whole card.
  // (Looked up across the whole catalogue — tests/catalogueLookup.test.ts.)
  assert.match(build, /const matched = await Promise\.all\(p\.lines\.map\(\(line\) => resolveCatalogueProduct\(line\)\)\);\s*if \(matched\.some\(\(product\) => !product\)\) continue;/);
  assert.match(code("src/lib/catalogueLookup.ts"), /const ON_SALE = \{ active: true, deletedAt: null \};/);
  // The price on the card is the product's, not anything from the proposal.
  assert.match(build, /unitPriceCents: product\.basePriceCents/);
  assert.match(build, /description: product\.name/);
  // The planner is told to look the catalogue up for any quote — DAX had answered "I don't have a catalogue result".
  assert.match(code("src/lib/crmAssistantPlan.ts"), /ALWAYS run this when the person asks for a quote or names a product to quote/);
  assert.match(QUOTE_BUILD_RULE, /ALWAYS look the catalogue up with knowledge BEFORE you answer anything about a quote — never say you cannot verify a product without having looked\./);
});

test("CONFIRM CREATES A DRAFT AND NOTHING ELSE: catalogue re-read, stale prices refused, never sent", () => {
  const actions = code("src/app/actions/assistant.ts");
  const at = actions.indexOf('case "quote_build": {');
  const run = actions.slice(at, actions.indexOf('case "quote_pdf": {'));
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
  assert.match(code("src/lib/catalogueLookup.ts"), /const KNOWLEDGE_FIELDS = \{ id: true, name: true, category: true, basePriceCents: true,/);
  assert.match(tool, /products: relevant\.map\(\(p\) => \(\{[\s\S]{0,420}productId: p\.id,\s*product: p\.name,/);
  // …and that is the name the task and the rule use for it.
  assert.match(QUOTE_BUILD_RULE, /Name each line's product by its productId from those results/);
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ productId: PRODUCT, qty: 1 }] }]).length, 1);
  // The card builder accepts exactly such an id — matched against the same catalogue, on sale only.
  assert.match(quoteBranch(), /resolveCatalogueProduct\(line\)/);
});

test("THE PDF IS QUEUED WITH THE QUOTE — delivered wherever Confirm was pressed, by the delivery that retries", () => {
  // Review of #872: (2) a quote confirmed in the CRM chat sent no PDF to WhatsApp at all;
  // (3) on WhatsApp the task was marked done before the PDF was rendered and sent, so a
  // crash there lost it for good. Both: the action now QUEUES it as an update for the
  // person, straight after the quote is saved, and the assistant's durable sender delivers.
  const actions = code("src/app/actions/assistant.ts");
  const at = actions.indexOf('case "quote_build": {');
  const run = actions.slice(at, actions.indexOf('case "quote_pdf": {'));
  // ATOMIC (second review of #872): the delivery record used to be written AFTER the
  // quote, in its own statement, with its failure swallowed — a built quote could exist
  // with nothing for the retrying delivery to find. It is now written by the save
  // itself, inside the transaction that creates the quote: both, or neither.
  assert.match(run, /intent: "draft",[\s\S]{0,420}pdfToMyWhatsApp: true,/);
  assert.doesNotMatch(run, /assistantTurn\.create|source: QUOTE_PDF_SOURCE/, "the action no longer writes the record itself");
  const quotes = code("src/app/actions/quotes.ts");
  const tx = quotes.slice(quotes.indexOf("const result = await basePrisma.$transaction(async (tx) => {"), quotes.indexOf("if (!result) {"));
  const createdAt = tx.indexOf("const created = await tx.quote.create({");
  const queuedAt = tx.indexOf("await tx.assistantTurn.create({", createdAt);
  assert.ok(createdAt > 0 && queuedAt > createdAt, "written on the SAME transaction client, after the quote row");
  // Two, both inside the transaction: this one, and the one for a draft that was added to (assistantQuoteAdd.test.ts).
  assert.equal((quotes.match(/assistantTurn\.create\(/g) ?? []).length, 2, "and nowhere outside it");
  assert.equal((tx.match(/await tx\.assistantTurn\.create\(/g) ?? []).length, 2);
  const record = tx.slice(queuedAt, queuedAt + 620);
  // For the signed-in person only — the input names no recipient, and cannot.
  assert.match(record, /tenantId: actingTenant,\s*userId: user\.id,\s*source: QUOTE_PDF_SOURCE,\s*quoteId: created\.id,/);
  assert.match(quotes, /pdfToMyWhatsApp: z\.boolean\(\)\.optional\(\),/);
  assert.doesNotMatch(quotes, /pdfTo(Phone|Number|User)|deliverTo/);
  // Only a DRAFT, in both paths: never on a save that marks the quote sent.
  assert.equal((tx.match(/if \(data\.pdfToMyWhatsApp && data\.intent === "draft"\) \{/g) ?? []).length, 2);
  assert.equal((tx.match(/assistantTurn\.create\(/g) ?? []).length, 2, "each write sits behind that test");
  // It says the number, the quote's own total, and that it was not sent.
  assert.match(record, /I've created draft quote Q-\$\{number\} \(\$\{formatZAR\(Math\.round\(total\)\)\}\)\. It has NOT been sent to the customer/);
  // Confirmed in the CRM: this action tries the send, briefly, and cannot be failed by it; on WhatsApp the door sends it after its reply.
  // (One helper, shared with quote_add: it does nothing unless Confirm was pressed in the CRM.)
  assert.match(run, /await sendQueuedPdfNow\(\);\s*return \{\s*ok: true,/);
  const sendNow = actions.slice(actions.indexOf("const sendQueuedPdfNow = async () => {"), actions.indexOf("switch (card?.kind) {"));
  assert.match(sendNow, /if \(via !== "crm"\) return;/);
  assert.match(sendNow, /return sendUpdatesToLinkedPhone\(ownedWriteTenantId\(\), user\.id\);\s*\}\)\(\)\.catch\(/);
  assert.match(sendNow, /setTimeout\(resolve, QUOTE_PDF_SEND_WAIT_MS\)/);
  assert.match(actions, /via: "crm" \| "whatsapp" = "crm",/);
  // The total the person is told is the QUOTE's own (VAT, discounts), read back from what was saved.
  assert.match(run, /const total = built \? formatZAR\(Math\.round\(payableTotalCents\(built\)\)\) : null;/);

  // It is an update like a briefing: the sweep retries it, and the bubble shows it.
  const rules = code("src/lib/assistantWhatsAppRules.ts");
  assert.match(rules, /export const PROACTIVE_SOURCES = \["schedule", "watch", "handoff", "quote_pdf", "proactive", "brief", "followup"\] as const;/);
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
  assert.match(send, /await sendWhatsAppDocument\(waId, \{ content: pdf, filename: quotePdfFileName\(quote\.number, \(await getCompanyProfile\(tenantId\)\)\.name\), contentType: "application\/pdf" \}, `\$\{what\} Q-\$\{quote\.number\} — for you\. This copy was not sent to the customer\.`\)/);
  // In this workspace, still there — and theirs, or one they may open NOW (a colleague's
  // draft they added to, or a quote whose PDF they asked for: assistantQuoteAdd.test.ts).
  assert.match(send, /basePrisma\.quote\.findFirst\(\{ where: \{ id: quoteId, tenantId, deletedAt: null \}, select: \{ id: true, number: true, status: true, createdById: true \} \}\)/);
  // EVERY delivery asks whether they may open it now — their own quotes included (review of #879).
  assert.match(send, /const mayOpen =\s*\(await canAccessQuote\(user, quote\.id\)\) \|\|\s*\(quote\.createdById === userId && quote\.status === "draft" && \(await hasPermission\(user, "quotes\.create"\)\)\);\s*if \(!mayOpen\) return null;/);
  assert.doesNotMatch(send, /createdById !== userId/, "no path skips the check for the creator");
  assert.ok(send.indexOf("canAccessQuote(user, quote.id)") < send.indexOf("await quotePdf(quote.id)"), "before anything is rendered");
  // It looks up no customer and no other number, and changes nothing about the quote.
  const body = send.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(body, /contact\.|lead\.|\.phone|\.whatsapp|quote\.(update|updateMany|create|delete)\(|markQuoteSentIfDraft|sendEmail|status: (?!true)|emailedAt/);
  const renderer = code("src/lib/quotePdf.ts");
  assert.match(renderer, /renderQuotePrintHtml\(\{ quoteId \}\)/);
  // The renderer it uses cannot change a quote: it holds no database client at all.
  assert.doesNotMatch(renderer, /prisma|updateMany|status/);
  // TWO KINDS OF FAILURE (second review of #872): nothing to render is permanent; a
  // conversion that did not work this time is passing, and must not close the delivery.
  assert.match(renderer, /if \(!html\) return \{ ok: false, reason: "no_document" \};/);
  assert.match(renderer, /return \{ ok: true, pdf: await htmlToPdf\(html\) \};\s*\} catch \(err\) \{\s*await logPdfError\(err\);\s*return \{ ok: false, reason: "failed" \};/);
  assert.match(send, /if \(rendered\.reason === "failed"\) return "The quote PDF could not be rendered just now";/);
});

test("in the CRM chat the card shows the same lines before Confirm", () => {
  assert.match(code("src/components/AssistantActionCard.tsx"), /\(card\.kind === "quote_build" \|\| card\.kind === "quote_add" \|\| card\.kind === "quote_change"\) && <p className="mt-2 whitespace-pre-line text-xs text-muted-foreground">\{card\.text\}<\/p>/);
});
