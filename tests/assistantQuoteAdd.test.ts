import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, QUOTE_ADD_MAX_FEES, quoteAddText, splitActions } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";

/*
 * "Please add R5000 Delivery Fee to the quote" (Sean, 2026-10-12) was refused:
 * DAX could build a quote and then not touch it. quote_add adds a fee or a
 * catalogue line to a quote that is still a DRAFT, after a Confirm.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const propose = (task: unknown) => splitActions(`ok\nACTIONS: ${JSON.stringify([task])}`).actions;

test("a fee is proposed with the amount the person said; nothing else about the quote can ride along", () => {
  assert.deepEqual(propose({ type: "quote_add", quote: "Q-1030", fees: [{ label: "Delivery Fee", amount: 5000, delivery: true }] }), [
    { type: "quote_add", quote: "Q-1030", fees: [{ label: "Delivery Fee", amount: 5000, delivery: true }] },
  ]);
  assert.equal(propose({ type: "quote_add", quote: "Q-1030", lines: [{ product: "Rover XL", qty: 1 }] }).length, 1);
  // Refused: a credit, a zero, a status, a recipient, a price on a product line, too many fees.
  for (const bad of [
    { fees: [{ label: "Discount", amount: -5000 }] },
    { fees: [{ label: "Free", amount: 0 }] },
    { fees: [{ label: "Delivery", amount: 5000 }], status: "sent" },
    { fees: [{ label: "Delivery", amount: 5000 }], to: "customer" },
    { lines: [{ product: "Rover XL", qty: 1, unitPrice: 1 }] },
    { fees: Array.from({ length: QUOTE_ADD_MAX_FEES + 1 }, () => ({ label: "Fee", amount: 10 })) },
  ]) {
    assert.deepEqual(propose({ type: "quote_add", quote: "Q-1030", ...bad }), [], JSON.stringify(bad));
  }
});

test("the card says exactly what is added, and that it stays a draft", () => {
  const text = quoteAddText(
    [{ productId: "p", description: "Denago Rover XL", qty: 2, unitPriceCents: 100_00, discountPct: 10, colour: "White" }],
    [{ label: "Delivery Fee", amountCents: 5000_00, delivery: true }],
    (cents) => `R${cents / 100}`,
  );
  assert.equal(text, "Delivery: Delivery Fee — R5000\n2 × Denago Rover XL (White) — R100 each, less 10%\nAdded to the DRAFT — nothing already on it changes, and it is not sent to the customer.");
});

test("DAX is told it can, and it is confirmable on WhatsApp", () => {
  assert.match(ACTION_INSTRUCTIONS, /quote_add: ADD to a quote that is still a DRAFT/);
  assert.match(ACTION_INSTRUCTIONS, /Never say you cannot add a fee or a line to a draft quote/);
  assert.match(ACTION_INSTRUCTIONS, /never to the customer/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("quote_add"));
  // Sean, 2026-10-12: the PDF had just arrived and DAX said "I can't attach the PDF in this WhatsApp chat".
  assert.match(ACTION_INSTRUCTIONS, /THE PDF IS DELIVERED FOR YOU, as its own document message/);
  assert.match(ACTION_INSTRUCTIONS, /never say a PDF cannot be sent or attached on WhatsApp/);
});

test("\"send me the PDF of Q-1030\": a task that names a quote and nothing else, and reaches only the person asking", () => {
  assert.deepEqual(propose({ type: "quote_pdf", quote: "Q-1030" }), [{ type: "quote_pdf", quote: "Q-1030" }]);
  // No recipient can be named.
  for (const extra of [{ to: "27820000000" }, { contactId: "cmcontactabcdefghijklmno" }, { phone: "x" }, { sendToCustomer: true }]) {
    assert.deepEqual(propose({ type: "quote_pdf", quote: "Q-1030", ...extra }), [], JSON.stringify(extra));
  }
  assert.match(ACTION_INSTRUCTIONS, /quote_pdf: SEND THEM a quote's PDF/);
  assert.match(ACTION_INSTRUCTIONS, /Never say you cannot send a quote's PDF/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("quote_pdf"));

  // A card only for a quote they may open, with something on it.
  const assistant = code("src/lib/crmAssistant.ts");
  const card = assistant.slice(assistant.indexOf('if (p.type === "quote_pdf")'), assistant.indexOf('if (p.type === "quote_add")'));
  assert.match(card, /hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)\)\) continue;/);
  assert.match(card, /!quote \|\| quote\._count\.items === 0 \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) continue;/);

  // Confirm: access asked again, a linked phone required, ONE update queued for the signed-in person — no number anywhere.
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "quote_pdf": {'), action.indexOf('case "quote_change": {'));
  assert.match(run, /!quote \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) return untouched/);
  assert.match(run, /assistantPhoneLink\.findFirst\(\{ where: \{ userId: user\.id, verifiedAt: \{ not: null \}, waId: \{ not: null \} \}/);
  assert.match(run, /userId: user\.id,\s*source: QUOTE_PDF_SOURCE,\s*quoteId: quote\.id,/);
  assert.doesNotMatch(run, /waId:\s*(card|String)|sendWhatsApp|card\.(to|phone|waId)/);
  // Nothing on the quote changes.
  assert.doesNotMatch(run, /quote\.update|saveQuoteDraft|markQuoteSent|status: (?!true)/);
  assert.match(run, /await sendQueuedPdfNow\(\);/);
});

test("only a draft the person may edit and open becomes a card", () => {
  const assistant = code("src/lib/crmAssistant.ts");
  const branch = assistant.slice(assistant.indexOf('if (p.type === "quote_add")'), assistant.indexOf('if (p.type === "quote_build")'));
  assert.match(branch, /hasPermission\(user, "quotes\.edit"\)\)\) continue;/);
  assert.match(branch, /quote\.status !== "draft" \|\| !quote\.contactId \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) continue;/);
  // Read through the workspace's own client — never the bypass one.
  assert.match(branch, /await prisma\.quote\.findFirst\(/);
  assert.match(branch, /resolveCatalogueProduct\(line\)/);
  assert.match(branch, /unitPriceCents: product\.basePriceCents/);
});

test("Confirm saves through the quote editor's own door, keeping every existing row, and queues the PDF for the person", () => {
  const action = code("src/app/actions/assistant.ts");
  const branch = action.slice(action.indexOf('case "quote_add":'), action.indexOf("default:", action.indexOf('case "quote_add":')));
  assert.match(branch, /!\(await hasPermission\(user, "quotes\.edit"\)\) \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) return untouched/);
  assert.match(branch, /quote\.status !== "draft" \|\| !quote\.contactId\) return untouched/);
  assert.match(branch, /byId\.get\(line\.productId\)\?\.basePriceCents !== line\.unitPriceCents/);
  assert.match(branch, /await saveQuoteDraft\(\{\s*id: quote\.id,/);
  assert.match(branch, /intent: "draft",/);
  assert.doesNotMatch(branch, /intent: "sent"/);
  assert.match(branch, /pdfToMyWhatsApp: true,/);
  // ADD-ONLY (review of #879, finding 1): the action sends the additions and nothing else. It does not read the
  // quote's rows, so it holds no copy of them that could be out of date by the time the save locks the quote.
  assert.match(branch, /appendOnly: true,/);
  // (Up to and including the save. Afterwards it reads the saved quote once, to report the new total.)
  const upToSave = branch.slice(0, branch.indexOf("if (!saved.ok"));
  assert.doesNotMatch(upToSave, /quote\.items|quote\.fees|include: \{|validUntil|taxInclusive|depositType|depositValue/);
  // ONCE (finding 2): no key, no run; and a card already carried out is reported as done, not run again.
  assert.match(branch, /if \(!CONFIRM_KEY\.test\(String\(card\.confirmKey \?\? ""\)\)\) return untouched\(STALE_CARD\);/);
  assert.match(branch, /confirmKey: card\.confirmKey,/);
  assert.match(branch, /if \(!saved\.ok && saved\.repeated\) return \{ ok: true, success: "Already added — nothing was added twice\./);

  // The edit path writes the delivery record in the same transaction as the rows.
  const quotes = code("src/app/actions/quotes.ts");
  const edit = quotes.slice(quotes.indexOf("if (data.id) {"), quotes.indexOf("const number = await nextQuoteNumber(tx)", quotes.indexOf("if (data.id) {")));
  assert.match(edit, /if \(data\.pdfToMyWhatsApp && data\.intent === "draft"\) \{[\s\S]*?await tx\.assistantTurn\.create\(\{[\s\S]*?userId: user\.id,\s*source: QUOTE_PDF_SOURCE,\s*quoteId: existing\.id,/);
});

test("ADD-ONLY is done under the quote's lock, from what is on the quote THEN — it rewrites nothing (review of #879)", () => {
  const quotes = code("src/app/actions/quotes.ts");
  const tx = quotes.slice(quotes.indexOf("const result = await basePrisma.$transaction(async (tx) => {"), quotes.indexOf("if (result === REPEATED) {"));
  const add = tx.slice(tx.indexOf("if (data.appendOnly) {"), tx.indexOf("if (data.changes) {"));
  assert.ok(add.length > 0);
  // After the lock and the editability check, which read the quote as it is now.
  assert.ok(tx.indexOf("FOR UPDATE") < tx.indexOf("if (data.appendOnly) {"));
  assert.ok(tx.indexOf("(await hasOpenSignatureRequest(tx, existing.id))") < tx.indexOf("if (data.appendOnly) {"));
  // It only creates rows. Nothing is deleted, and the header is not written from the request.
  assert.doesNotMatch(add, /deleteMany|priorById|data\.terms|validUntil|cpqQuoteData|contactId: data\.contactId/);
  assert.match(add, /data: \{ status: "draft" \}/);
  assert.match(add, /itemRowsFor\(normalizedItems, new Map\(\)/);
  assert.match(add, /feeRowsFor\(normalizedFees, new Map\(\)/);
  assert.match(add, /sortOrder: existing\.fees\.length \+ at/);
  // The total it reports is worked out from the rows read under the lock plus what was added, with the quote's own VAT mode and deposit.
  assert.match(add, /return finish\(\[\.\.\.existing\.items, \.\.\.addedItems\], \[\.\.\.existing\.fees, \.\.\.addedFees\], \{\s*taxInclusive: existing\.taxInclusive,/);
  // A different customer than the quote's, or anything but a draft save, is refused.
  assert.match(add, /if \(data\.intent !== "draft" \|\| existing\.contactId !== data\.contactId\) return null;/);
});

test("ONE CONFIRM, ONE CHANGE: the card's key is spent in the transaction that makes the change (review of #879)", async () => {
  const { CONFIRM_KEY } = await import("../src/lib/assistantActions");
  assert.ok(CONFIRM_KEY.test("qk_0123456789abcdef0123456789abcdef"));
  for (const bad of ["", "qk_short", "cmabcdefghijklmnopqrstuv", "qk_0123456789abcdef0123456789abcdeg", "qk_0123456789abcdef0123456789abcdef0"]) assert.ok(!CONFIRM_KEY.test(bad), bad);

  // Minted on the server when the card is made — for every card that changes a quote (build, add, change).
  const assistant = code("src/lib/crmAssistant.ts");
  assert.equal((assistant.match(/confirmKey: `qk_\$\{randomBytes\(16\)\.toString\("hex"\)\}`,/g) ?? []).length, 3);

  const quotes = code("src/app/actions/quotes.ts");
  assert.match(quotes, /confirmKey: z\.string\(\)\.regex\(CONFIRM_KEY\)\.optional\(\),/);
  const claim = quotes.slice(quotes.indexOf("const claimConfirmKey = async ("), quotes.indexOf("const result = await basePrisma.$transaction("));
  // The key IS the row's primary key: found → already done; otherwise written on the SAME transaction client.
  assert.match(claim, /if \(await tx\.assistantPendingAction\.findFirst\(\{ where: \{ id: data\.confirmKey, tenantId: actingTenant \}, select: \{ id: true \} \}\)\) return false;/);
  assert.match(claim, /await tx\.assistantPendingAction\.create\(\{\s*data: \{\s*id: data\.confirmKey, tenantId: actingTenant, userId: user\.id,/);
  // Spent, never offered: completed at once, so neither the WhatsApp confirm path nor the Ask page's list picks it up.
  assert.match(claim, /confirmedAt: now, completedAt: now,/);
  assert.doesNotMatch(claim, /forCrm: true/);
  // It holds no customer details.
  assert.match(claim, /card: \{ kind: "confirm_key", what \}/);

  const tx = quotes.slice(quotes.indexOf("const result = await basePrisma.$transaction(async (tx) => {"), quotes.indexOf("if (result === REPEATED) {"));
  // Claimed before anything is written, in every path: adding to a draft, changing its rows, and creating a quote.
  const add = tx.slice(tx.indexOf("if (data.appendOnly) {"));
  assert.ok(add.indexOf("claimConfirmKey(tx,") < add.indexOf("tx.quote.updateMany("));
  assert.ok(tx.indexOf('claimConfirmKey(tx, "a new quote")') < tx.indexOf("const number = await nextQuoteNumber(tx);"));
  assert.equal((tx.match(/if \(!\(await claimConfirmKey\(tx, [^)]*\)\)\) return REPEATED;/g) ?? []).length, 3);
  // Two at the same instant: the loser's key collides, its transaction is undone, and it is reported as repeated.
  assert.match(tx, /\(error as \{ code\?: string \}\)\.code === "P2002"\) return REPEATED;/);
  assert.match(quotes, /if \(result === REPEATED\) \{\s*return \{ ok: false, error: "That was already confirmed[^"]*", repeated: true \};/);
});
