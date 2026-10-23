import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, matchQuoteRow, quoteChangeText, splitActions, type QuoteChange } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";

/*
 * Sean, 2026-10-12, three refusals in a row on a draft DAX had built:
 * "change description of delivery fee to Delivery Fee - Hermanus",
 * "remove delivery fee from Q-1030", "change color of rover from lava to white".
 * quote_change changes or removes rows that are already on a DRAFT, after a Confirm.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const propose = (task: unknown) => splitActions(`ok\nACTIONS: ${JSON.stringify([task])}`).actions;

test("the three things he asked for can each be proposed — and a product's price cannot", () => {
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", fees: [{ fee: "Delivery Fee", label: "Delivery Fee - Hermanus" }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", fees: [{ fee: "delivery fee", remove: true }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", lines: [{ line: "Rover", colour: "White" }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", lines: [{ line: "Rover", qty: 3, discountPct: 5 }] }).length, 1);
  // Refused: a price on a product line, a credit, a status, a customer, a recipient.
  for (const bad of [
    { lines: [{ line: "Rover", unitPrice: 1 }] },
    { lines: [{ line: "Rover", unitPriceCents: 1 }] },
    { lines: [{ line: "Rover", qty: 0 }] },
    { fees: [{ fee: "Delivery Fee", amount: -5 }] },
    { fees: [{ fee: "Delivery Fee", label: "x" }], status: "sent" },
    { fees: [{ fee: "Delivery Fee", label: "x" }], contactId: "cmcontactabcdefghijklmno" },
    { fees: [{ fee: "Delivery Fee", label: "x" }], to: "customer" },
  ]) {
    assert.deepEqual(propose({ type: "quote_change", quote: "Q-1030", ...bad }), [], JSON.stringify(bad));
  }
});

test("a name must mean exactly ONE row on the quote — never a guess", () => {
  const fees = [{ label: "Delivery Fee" }, { label: "Licensing" }];
  const name = (row: { label: string }) => row.label;
  assert.equal(matchQuoteRow(fees, name, "delivery fee")?.label, "Delivery Fee", "ignoring case");
  assert.equal(matchQuoteRow(fees, name, "delivery")?.label, "Delivery Fee", "the only one containing it");
  assert.equal(matchQuoteRow(fees, name, "fee")?.label, "Delivery Fee", "still the only one containing it");
  assert.equal(matchQuoteRow(fees, name, "i"), null, "both contain it");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "Delivery Fee - Hermanus" }], name, "delivery"), null, "two candidates");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "Delivery Fee - Hermanus" }], name, "Delivery Fee")?.label, "Delivery Fee", "an exact name wins over a longer one");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "delivery fee" }], name, "Delivery Fee"), null, "two rows called the same");
  assert.equal(matchQuoteRow(fees, name, "handling"), null);
  assert.equal(matchQuoteRow(fees, name, "  "), null);
});

test("the card shows each row before and after", () => {
  const changes: QuoteChange[] = [
    { row: "fee", id: "f1", was: { label: "Delivery Fee", amountCents: 5000_00 }, label: "Delivery Fee - Hermanus" },
    { row: "fee", id: "f2", was: { label: "Licensing", amountCents: 1500_00 }, remove: true },
    { row: "line", id: "i1", was: { description: "Denago EV Rover XL", qty: 1, discountPct: 0, colour: "Lava" }, colour: "White" },
    { row: "line", id: "i2", was: { description: "Denago EV Nomad", qty: 2, discountPct: 0, colour: null }, qty: 3, discountPct: 5 },
  ];
  assert.equal(quoteChangeText(changes, (cents) => `R${cents / 100}`), [
    'Fee "Delivery Fee" (R5000) → "Delivery Fee - Hermanus" (R5000)',
    'Remove: Fee "Licensing" (R1500)',
    "1 × Denago EV Rover XL (Lava) → 1 × Denago EV Rover XL (White)",
    "2 × Denago EV Nomad → 3 × Denago EV Nomad, less 5%",
    "Changed on the DRAFT — nothing else on it changes, and it is not sent to the customer.",
  ].join("\n"));
});

test("DAX is told it can, and it is confirmable on WhatsApp", () => {
  assert.match(ACTION_INSTRUCTIONS, /quote_change: CHANGE or REMOVE something already on a quote that is still a DRAFT/);
  assert.match(ACTION_INSTRUCTIONS, /never say you cannot rename, change or remove a fee or a line on a draft quote/);
  assert.match(ACTION_INSTRUCTIONS, /It cannot set a product's price/);
  assert.match(ACTION_INSTRUCTIONS, /"type":"quote_change","quote":"Q-1030","fees":\[\{"fee":"Delivery Fee","label":"Delivery Fee - Hermanus"\}\]/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("quote_change"));
});

test("a card only for a draft they may edit and open, for rows that are on it, with a colour the product comes in", () => {
  const assistant = code("src/lib/crmAssistant.ts");
  const branch = assistant.slice(assistant.indexOf('if (p.type === "quote_change")'), assistant.indexOf('if (p.type === "quote_add")'));
  assert.match(branch, /if \(!\(await hasPermission\(user, "quotes\.edit"\)\)\) \{ problems\.push\("Your role can't edit quotes\."\); continue; \}/);
  // Not there and not theirs are told the same way: no card, and no hint that the quote exists.
  assert.match(branch, /if \(!quote \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) \{ problems\.push\(`I can't find quote \$\{p\.quote\} among the ones you can open\.`\); continue; \}/);
  assert.match(branch, /if \(quote\.status !== "draft" \|\| !quote\.contactId\) \{ problems\.push\(/);
  assert.ok(branch.indexOf("canAccessQuote(user, quote.id)") < branch.indexOf("const ref = `Q-${quote.number}`;"), "nothing about the quote is said before access is checked");
  assert.match(branch, /await prisma\.quote\.findFirst\(/);
  // A named row must mean exactly one; an unnamed one is the ONLY row of its kind, or nothing.
  assert.match(branch, /wanted\.fee \? matchQuoteRow\(quote\.fees, \(row\) => row\.label, wanted\.fee\) : quote\.fees\.length === 1 \? quote\.fees\[0\] : null;/);
  assert.match(branch, /wanted\.line \? matchQuoteRow\(quote\.items, \(row\) => row\.description, wanted\.line\) : quote\.items\.length === 1 \? quote\.items\[0\] : null;/);
  // One unclear target, or nothing actually changing, and there is no card — never part of what was asked. And it says why.
  assert.match(branch, /if \(problem\) \{ problems\.push\(problem\); continue; \}/);
  assert.ok(branch.indexOf("if (problem) { problems.push(problem); continue; }") < branch.indexOf("cards.push({"));
  assert.match(branch, /colours\.find\(\(colour\) => colour\.toLowerCase\(\) === wanted\.colour!\.toLowerCase\(\)\)/);
  // …with the nearest it does come in, as a question (2026-10-23).
  assert.match(branch, /if \(wanted\.colour && !offered\) \{\s*(\/\/[^\n]*\s*)*const near = closestColour\(wanted\.colour, colours\);\s*problem = `"\$\{wanted\.colour\}" is not a colour the \$\{line\.description\} comes in/);
  // ALREADY AS ASKED is said, not dropped (2026-10-13: "change the Rover to White" — it already was).
  assert.match(branch, /problem = `On \$\{ref\} the \$\{line\.description\} is already /);
  assert.match(branch, /problem = `On \$\{ref\} the fee "\$\{fee\.label\}" \(\$\{formatZAR\(fee\.amountCents\)\}\) is already as you asked/);
  assert.match(branch, /confirmKey: `qk_\$\{randomBytes\(16\)\.toString\("hex"\)\}`,/);
});

test("with ONE line on the quote, the line need not be named — and the same for a fee (2026-10-13: \"why ask the question?\")", () => {
  assert.equal(propose({ type: "quote_change", quote: "Q-1031", lines: [{ colour: "White" }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1031", fees: [{ remove: true }] }).length, 1);
  assert.match(ACTION_INSTRUCTIONS, /WHEN THE QUOTE HAS ONLY ONE LINE \(or only one fee\), that is the one they mean: leave "line" \(or "fee"\) out and do not ask which\./);
  assert.match(ACTION_INSTRUCTIONS, /The quote's lines and fees are in the quote results/);
  assert.match(ACTION_INSTRUCTIONS, /If it is already the way they asked \(the colour is already White\), say so and propose nothing\./);

  // DAX is SHOWN what is on a quote: its lines (with colour) and fees, as they are named there — in the quote
  // search, a lead's quotes, and a customer's quotes.
  const assistant = code("src/lib/crmAssistant.ts");
  assert.equal((assistant.match(/\.\.\.quoteContents\((quote|q)\),/g) ?? []).length, 3);
  const contents = assistant.slice(assistant.indexOf("function quoteContents("), assistant.indexOf("export async function findActivities("));
  assert.match(contents, /`\$\{item\.qty\} × \$\{item\.description\}\$\{item\.colorPreference \? ` — colour \$\{item\.colorPreference\}` : ""\}/);
  assert.match(contents, /fees: quote\.fees\.slice\(0, 12\)\.map\(\(fee\) => `\$\{fee\.label\} — \$\{formatZAR\(fee\.amountCents\)\}`\),/);
  // What a quote costs to make, and which lines are optional, are not among them.
  assert.doesNotMatch(contents, /costCents|unitPriceCents|optional|selected/);
});

test("THE ANSWER IS REPLACED when it speaks of a task that was not set up — never both statements at once (2026-10-13; review of #882)", async () => {
  const { settledAnswer, claimsSetUp } = await import("../src/lib/assistantActions");
  const { splitReply, REPLY_MARKER } = await import("../src/lib/assistantReply");
  // What he was sent, word for word.
  const SAID = "You mean Q-1030 for Test Customer, not Chevaan’s deal. I’ve set up the Rover XL colour change to White for you to confirm on your Ask page in the CRM. The quote is still a draft; nothing has gone to the customer.";
  const WHY = "On Q-1030 the Denago EV Rover XL is already 1 of them, White, no discount — there is nothing to change.";

  // The task came to nothing, with its reason: the claim is GONE, and what is said is true.
  const replaced = settledAnswer(SAID, [], [WHY], 0);
  assert.equal(replaced, `I couldn't set that up — there is nothing to confirm, and nothing was saved or changed.\n• ${WHY}`);
  assert.doesNotMatch(replaced ?? "", /I’ve set up|I've set up|for you to confirm on your Ask page/);

  // It came to nothing without a reason (a malformed task): still replaced, and it says so.
  assert.match(settledAnswer(SAID, [], [], 1) ?? "", /^I couldn't set that up[^\n]*\n• A task could not be set up\. Ask again with the exact details/);

  // NO TASK AT ALL, yet the words claim one (the case an appended note never reached).
  assert.match(settledAnswer(SAID, [], [], 0) ?? "", /^I haven't set anything up — there is nothing to confirm, and nothing was saved or changed\./);

  // Some made, some not: the answer is written from the CARDS — what is waiting, by its title, and what is not.
  const mixed = settledAnswer("I've set both up for you to confirm.", [{ title: "Change draft quote Q-1030" }], ["Q-1031 has no single fee called \"handling\". Its fees: none."], 0);
  assert.equal(mixed, 'Set up for you to confirm:\n• Change draft quote Q-1030\n\nNOT set up — nothing was saved or changed for this:\n• Q-1031 has no single fee called "handling". Its fees: none.');
  assert.doesNotMatch(mixed ?? "", /set both up/);

  // The assistant's own answer stands when the cards bear it out, or when it claimed nothing.
  assert.equal(settledAnswer("I've set that up for you to confirm.", [{ title: "Change draft quote Q-1030" }], [], 0), null);
  assert.equal(settledAnswer("Q-1030 is a draft for R240 000. Its Rover XL is White.", [], [], 0), null);

  // What counts as claiming a task is waiting — and what does not.
  for (const claim of [
    SAID,
    "I've set that up for you to confirm.",
    "I have saved it on your Ask page.",
    "I've queued the delivery fee — tap Confirm to add it.",
    "I’ve now set the colour change up for you to confirm.",
  ]) assert.equal(claimsSetUp(claim), true, claim);
  for (const fine of [
    "Q-1030's Rover XL is already White, so there is nothing to change.",
    "I can set that up for you to confirm — which quote?",
    "Should I set up a follow-up for you to confirm?",
    "I couldn't set that up.",
    "Open your Ask page to see earlier answers.",
    "I've looked at Q-1030: it is a draft.",
    "Anna confirmed the appointment and I've added nothing new.",
  ]) assert.equal(claimsSetUp(fine), false, fine);

  // The reply says how many tasks it TRIED to propose, counting the malformed ones the parser throws away.
  const reply = (actions: unknown[]) => splitReply(`I've set that up for you to confirm.\n${REPLY_MARKER}\n${JSON.stringify({ actions })}`);
  const ok = { type: "quote_change", quote: "Q-1030", lines: [{ colour: "White" }] };
  assert.deepEqual([reply([ok]).attempted, reply([ok]).actions.length], [1, 1]);
  assert.deepEqual([reply([{ ...ok, lines: [{ color: "White" }] }]).attempted, reply([{ ...ok, lines: [{ color: "White" }] }]).actions.length], [1, 0], "a misspelt field: tried, and not made");
  assert.deepEqual([reply([ok, { type: "made_up" }]).attempted, reply([ok, { type: "made_up" }]).actions.length], [2, 1]);
  assert.equal(splitReply("Just an answer.").attempted, 0);

  // Wired: decided from the cards that came out and the reasons the tasks gave; it REPLACES the answer that is
  // shown AND saved — only where tasks can be proposed at all — and a replaced answer carries no citations.
  const assistant = code("src/lib/crmAssistant.ts");
  assert.match(assistant, /const actions = !proposes \? \[\] : await resolveActions\(user, proposals, problems\)\.catch\(/);
  // A check-back DAX set itself (proactive DAX part 3) is a task that WAS set up, so it isn't counted as one that came to nothing.
  assert.match(assistant, /const settled = proposes \? settledAnswer\(resolved\.plain, actions, problems, Math\.max\(0, reply\.attempted - checkBacks\.length - actions\.length - problems\.length\)\) : null;/);
  assert.match(assistant, /const cited = \(settled \?\? resolved\.cited \+ note\) \+ checkBackLine;\s*const answer = \(settled \?\? resolved\.plain \+ note\) \+ checkBackLine;/);
  assert.match(assistant, /\.\.\.\(source === "chat" && evidence\.length && !settled \? \{ cited, evidence \} : \{\}\),/);
  const answerAt = assistant.indexOf("const answer = (settled ?? resolved.plain + note) + checkBackLine;");
  assert.ok(answerAt > 0 && answerAt < assistant.indexOf("tools: observations.map((o) => ({ tool: o.tool, args: o.args })) as object,"), "before the turn is saved, so the kept answer is the true one");
});

test("Confirm hands the changes to the quote editor's save — once, and never as a send", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "quote_change": {'), action.indexOf('case "quote_add": {'));
  assert.match(run, /if \(!CONFIRM_KEY\.test\(String\(card\.confirmKey \?\? ""\)\)\) return untouched\(STALE_CARD\);/);
  assert.match(run, /!quote \|\| !\(await hasPermission\(user, "quotes\.edit"\)\) \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) return untouched/);
  assert.match(run, /quote\.status !== "draft" \|\| !quote\.contactId\) return untouched/);
  assert.match(run, /await saveQuoteDraft\(\{\s*id: quote\.id,\s*contactId: quote\.contactId,\s*terms: "",\s*intent: "draft",\s*items: \[\],\s*changes,\s*confirmKey: card\.confirmKey,\s*pdfToMyWhatsApp: true,\s*\}\);/);
  assert.doesNotMatch(run, /intent: "sent"|sendEmail|sendWhatsApp(Message|Text|Document)/);
  assert.match(run, /if \(!saved\.ok && saved\.repeated\) return \{ ok: true, success: "Already changed/);
});

test("UNDER THE LOCK: every row must still read as the card showed it, or nothing changes; then only those rows are written", () => {
  const quotes = code("src/app/actions/quotes.ts");
  const tx = quotes.slice(quotes.indexOf("const result = await basePrisma.$transaction(async (tx) => {"), quotes.indexOf("if (result === STALE) {"));
  const change = tx.slice(tx.indexOf("if (data.changes) {"), tx.indexOf("if (existing.leadId && existing.contactId && existing.contactId !== data.contactId) {"));
  assert.ok(change.length > 0);
  assert.ok(tx.indexOf("FOR UPDATE") < tx.indexOf("if (data.changes) {"));
  assert.ok(tx.indexOf("(await hasOpenSignatureRequest(tx, existing.id))") < tx.indexOf("if (data.changes) {"));
  // The check of every row comes before the key is spent and before any write.
  const firstWrite = Math.min(...["tx.quote.updateMany(", "tx.quoteFee.deleteMany(", "tx.quoteFee.updateMany(", "tx.quoteItem.deleteMany(", "tx.quoteItem.updateMany("].map((call) => change.indexOf(call)));
  assert.ok(change.lastIndexOf("return STALE;") < change.indexOf("claimConfirmKey(tx,"));
  assert.ok(change.indexOf("claimConfirmKey(tx,") < firstWrite);
  assert.match(change, /if \(!fee \|\| fee\.label !== change\.was\.label \|\| fee\.amountCents !== change\.was\.amountCents\) return STALE;/);
  assert.match(change, /!line \|\| line\.description !== change\.was\.description \|\| line\.qty !== change\.was\.qty \|\|\s*line\.discountPct !== change\.was\.discountPct \|\| \(line\.colorPreference \?\? null\) !== change\.was\.colour\s*\) return STALE;/);
  // A colour is checked against the line's own product, in the quote's workspace.
  assert.match(change, /tx\.product\.findFirst\(\{ where: \{ id: line\.productId, tenantId: ownerTenantId \}, select: \{ colors: \{ select: \{ name: true \} \} \} \}\)/);
  assert.match(change, /if \(!product\?\.colors\.some\(\(colour\) => colour\.name === change\.colour\)\) return STALE;/);
  // Each write names the row, THIS quote and its workspace — and must hit exactly one row.
  assert.equal((change.match(/where: \{ id: change\.id, quoteId: existing\.id, tenantId: ownerTenantId \}/g) ?? []).length, 4);
  assert.equal((change.match(/if \(done\.count !== 1\) throw new Error\(/g) ?? []).length, 2);
  // No price, no cost, no optional/selected, no header field is settable.
  assert.doesNotMatch(change, /unitPriceCents|costCents|optional:|selected:|data\.terms|validUntil|cpqQuoteData|contactId: data\.contactId|createMany/);
  assert.match(change, /if \(data\.intent !== "draft" \|\| existing\.contactId !== data\.contactId\) return null;/);
  // The schema bounds every value and admits no other field on a change.
  const schema = quotes.slice(quotes.indexOf("changes: z.array(z.discriminatedUnion(\"row\", ["), quotes.indexOf("confirmKey: z.string().regex(CONFIRM_KEY)"));
  assert.equal((schema.match(/\}\)\.strict\(\),/g) ?? []).length, 2);
  assert.match(schema, /amountCents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(100_000_000\)\.optional\(\),/);
  assert.match(schema, /qty: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\),/);
  assert.doesNotMatch(schema, /unitPriceCents/);
  assert.match(quotes, /if \(result === STALE\) \{\s*return \{ ok: false, error: "That quote has changed since this was suggested, so nothing was changed\./);
});

test("A QUOTE CAN BE LOOKED UP BY ITS NUMBER — or its lines are only seen when it happens to be among the newest", async () => {
  // Sean, 2026-10-13, "On quote q-1031 make colour white": the search had status, age and value filters and no
  // way to ask for one quote, so the quote named was found by luck or not at all.
  const { quoteArgs, planInstructions } = await import("../src/lib/crmAssistantPlan");
  for (const number of ["Q-1031", "q-1031", "Q1031", "1031", 1031]) assert.equal(quoteArgs.safeParse({ number }).success, true, String(number));
  for (const bad of ["Q-", "Q-10 31", "1031; drop", "Q-1031 OR 1=1", -3, 0, 1.5, "Q-12345678901"]) assert.equal(quoteArgs.safeParse({ number: bad }).success, false, String(bad));
  assert.equal(quoteArgs.safeParse({ number: "Q-1031", id: "x" }).success, false, "still no other way in");

  // DAX is told to use it whenever a quote is named, and what comes back.
  const plan = code("src/lib/crmAssistantPlan.ts");
  assert.match(plan, /find_quotes: \{"number":"Q-1031" \(ONE quote by its number — use this whenever they name a quote; it returns that quote\\'s lines with quantity and colour, and its fees\)/);
  assert.equal(typeof planInstructions, "function");

  // That one quote — and still only if this person may open it: the number narrows, the access filter stays.
  const assistant = code("src/lib/crmAssistant.ts");
  const find = assistant.slice(assistant.indexOf("async function findQuotes("), assistant.indexOf("function quoteContents("));
  assert.match(find, /const wantedNumber = args\.number === undefined \? null : Number\(String\(args\.number\)\.replace\(\/\^Q-\?\/i, ""\)\);/);
  assert.match(find, /\.\.\.\(wantedNumber === null \? \{ supersededAt: null \} : \{ number: wantedNumber \}\),\s*\.\.\.\(ids === null \? \{\} : \{ id: \{ in: ids \} \}\),/);
  assert.match(find, /const ids = await getAccessibleQuoteIds\(user\);/);
  assert.match(find, /\.\.\.quoteContents\(quote\),/);
});

test("A CUSTOMER'S RECORD LISTS THEIR QUOTES — a quote on no deal was invisible (2026-10-13: DAX asked for a screenshot)", () => {
  const assistant = code("src/lib/crmAssistant.ts");
  const named = assistant.slice(assistant.indexOf("export async function customersNamed("), assistant.indexOf("export async function leadBrief("));
  // Only quotes this person may open: their quote permission, then their access to each quote.
  assert.match(named, /const quoteIds = \(await hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)\) \? await getAccessibleQuoteIds\(user\) : \[\];/);
  assert.match(named, /where: \{ contactId: \{ in: found\.map\(\(c\) => c\.id\) \}, deletedAt: null, supersededAt: null, \.\.\.\(quoteIds === null \? \{\} : \{ id: \{ in: quoteIds \} \}\) \},/);
  assert.match(named, /found\.length === 0 \|\| \(quoteIds !== null && quoteIds\.length === 0\) \? \[\]/, "no quote access, no quote query");
  // Each with its number and what is on it — the names quote_change matches against.
  assert.match(named, /quotes: quotes\.filter\(\(q\) => q\.contactId === c\.id\)\.slice\(0, 5\)\.map\(\(q\) => \(\{\s*quote: `Q-\$\{q\.number\}`,/);
  assert.match(named, /\.\.\.quoteContents\(q\),/);
  // Still no phone numbers or emails on a customer.
  assert.doesNotMatch(named, /phone|email/i);
});

test("DAX proposes the change even when it cannot see the quote — and never asks the person for a screenshot", () => {
  assert.match(ACTION_INSTRUCTIONS, /IF YOU CANNOT SEE WHAT IS ON THE QUOTE, PROPOSE THE CHANGE ANYWAY/);
  assert.match(ACTION_INSTRUCTIONS, /NEVER ask the person for a screenshot, or to tell you what is on a quote, or what its status is\./);
  // …which is safe because a task that finds no such row says so, with what IS on the quote (settledAnswer).
  const assistant = code("src/lib/crmAssistant.ts");
  assert.match(assistant, /`\$\{ref\} has no single fee called "\$\{wanted\.fee\}"` : `Which fee on \$\{ref\}\?`\} Its fees: \$\{named\(quote\.fees\.map\(\(row\) => row\.label\)\)\}\./);
});
