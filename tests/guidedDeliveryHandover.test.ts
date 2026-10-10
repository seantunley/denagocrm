import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  deliveryHandoverReadiness,
  deliveryNoteRuns,
  handoverRunSelection,
} from "../src/lib/checklists/deliveryHandover";

// The customer signs the delivery note itself, on its own screen. What they are
// about to sign for is checked when that is started, and frozen into the note.
const startSource = readFileSync("src/app/actions/deliverySigning.ts", "utf8");
const noteSigningSource = readFileSync("src/lib/deliveryNoteSigning.ts", "utf8");
const pageSource = readFileSync("src/app/(app)/deliveries/page.tsx", "utf8");
const completionSource = readFileSync("src/components/checklists/GuidedDeliveryCompletion.tsx", "utf8");
const deliveryNoteSource = readFileSync("src/app/(print)/quotes/[id]/delivery-note/page.tsx", "utf8");
// Which runs and which signature the note shows: one loader, shared by the fixed
// layout and the document-editor layout so the two cannot pick differently.
const deliveryEvidenceSource = readFileSync("src/lib/deliveryServicePrint.ts", "utf8");
// The delivery itself — gates, evidence and the write — shared by the board's
// markDelivered and the stock page's deliverStockUnit, so neither can skip them.
const deliverySource = readFileSync("src/lib/quoteDelivery.ts", "utf8");

test("guided delivery is unavailable rather than implicitly complete with no template", () => {
  assert.deepEqual(deliveryHandoverReadiness([], []), {
    configured: false,
    ready: false,
    missingTemplateIds: [],
  });
});

test("every active handover template needs a completed run before signing unlocks", () => {
  const templates = [{ id: "walkaround" }, { id: "customer-handover" }];
  const partial = deliveryHandoverReadiness(templates, [
    { templateId: "walkaround", completedAt: new Date() },
    { templateId: "customer-handover", completedAt: null },
  ]);
  assert.equal(partial.configured, true);
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.missingTemplateIds, ["customer-handover"]);

  const complete = deliveryHandoverReadiness(templates, [
    { templateId: "walkaround", completedAt: new Date() },
    { templateId: "customer-handover", completedAt: new Date() },
  ]);
  assert.equal(complete.ready, true);
  assert.deepEqual(complete.missingTemplateIds, []);
});

test("the server repeats the checklist, review and driver gates BEFORE the customer signs", () => {
  // The screen only offers the button once the checklist is complete, but that
  // is not a business rule until the server repeats it — and it has to be
  // repeated where the customer is about to be handed the device, because what
  // is checked there is what gets frozen into the note they sign.
  assert.match(startSource, /withActingStaffScope\(async \(\) => \{/);
  assert.match(startSource, /requireModuleEnabled\("automotive"\)/);
  assert.match(startSource, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(startSource, /reviewedHandoverRuns\(tenantId, quoteId, claimedRunIds\)/);
  assert.match(startSource, /deliveryNoteReviewed/);
  assert.match(startSource, /if \(!deliveredByName\) refuse\("Enter who handed over the vehicle\."\)/);
  assert.ok(
    startSource.indexOf("reviewedHandoverRuns(") < startSource.indexOf("await prepareDeliveryNote("),
    "the handover is verified before any note is made",
  );
  assert.match(noteSigningSource, /host: "quote\.delivery", active: true/);
  assert.match(noteSigningSource, /hostType: "quote\.delivery"/);
  assert.match(noteSigningSource, /deliveryHandoverReadiness\(templates, runs\)/);
});

test("a guided handover is delivered against the customer's signature on the note, or not at all", () => {
  // In deliverQuote, which every delivery button ends in — not in a wrapper a
  // direct call could walk around. The guided handover used to have an action
  // of its own that held this rule; it has none now, because there is nothing
  // left for it to hold.
  assert.equal(existsSync("src/app/actions/guidedDelivery.ts"), false, "the guided handover completes through markDelivered like any other");
  assert.match(deliverySource, /const signed = catchUp \? null : await signedDeliveryNote\(quoteId, tenantId\);/);
  const gate = deliverySource.slice(deliverySource.indexOf("if (handoverTemplates.length > 0) {"));
  assert.match(gate, /^if \(handoverTemplates\.length > 0\) \{\s*if \(!signed\) \{\s*refuse\("This delivery uses a guided handover\./);
  // A checklist switched on since, a run removed, a handover switched off: with
  // a signed note every one of them means "sign again", in those words.
  assert.match(deliverySource, /const CHANGED = "The handover changed after the customer signed the delivery note\. Ask them to sign it again from the delivery screen\.";/);
  assert.match(gate, /if \(!readiness\.ready \|\| verifiedRuns\.length !== handoverTemplates\.length\) refuse\(CHANGED\);/);
});

test("the delivery is recorded against the note the customer signed, not against the form", () => {
  const board = readFileSync("src/app/actions/fulfilment.ts", "utf8");
  const md = board.slice(board.indexOf("export async function markDelivered("));
  // The runs were this exported action's third argument and the signature a
  // field of its form — both arrive through the browser. Neither exists now.
  assert.match(md, /^export async function markDelivered\(quoteId: string, formData: FormData\): Promise<ActionResult> \{/);
  assert.doesNotMatch(board, /handoverRunIds|formData\.get\("signature"\)|deliverySignatureRef/, "the board's actions carry no runs and no signature");
  assert.doesNotMatch(deliverySource, /input\.handoverRunIds|handoverRunIds\?:/, "nor does the delivery accept any");
  assert.match(deliverySource, /const requestedRunIds = \[\.\.\.new Set\(signed\?\.runIds \?\? \[\]\)\];/, "the runs are the signed note's");
  // A caller cannot hand in a signature either: its evidence has no such field.
  assert.match(deliverySource, /export type DeliveryEvidence = \{\s*deliveredByName\?: string \| null;\s*deliveryChecklist\?: object;\s*\};/);

  const evidence = deliverySource.slice(deliverySource.indexOf("async (stage) => {"), deliverySource.indexOf("(evidence, documents) =>"));
  assert.match(evidence, /if \(!signed\) return \{ deliveredByName: said\.deliveredByName, deliveryChecklist: said\.deliveryChecklist, deliverySignatureRef: null \};/, "unsigned: the caller's word, and no signature");
  assert.match(evidence, /readFile\(signed\.signatureRef, quote\.tenantId\)/, "the signature they drew, read in the quote's own workspace");
  assert.match(evidence, /return \{ deliveredByName: signed\.deliveredByName \|\| null, deliveryChecklist: signed\.checklist \?\? undefined, deliverySignatureRef \};/, "signed: the note's word over the caller's");

  // The note is read before the transaction (its signature has to be staged
  // first), so it is proved again inside it — after the quote's row is held and
  // the requests are, so a signature landing this instant is seen.
  const tx = deliverySource.slice(deliverySource.indexOf("(evidence, documents) =>"));
  const held = tx.indexOf("tx.quote.updateMany(");
  const requests = tx.indexOf("await holdSubjectRequests(tx, note, tenantId);");
  const again = tx.indexOf("const current = await signedDeliveryNote(quoteId, tenantId, tx);");
  const withdraw = tx.indexOf("withdrawnNotes = await withdrawOpenSubjectRequests(tx, note, tenantId);");
  assert.ok(held >= 0 && held < requests && requests < again && again < withdraw, "quote row, then the requests, then the question, then the withdrawal");
  assert.match(tx, /if \(\(current\?\.requestId \?\? null\) !== \(signed\?\.requestId \?\? null\)\) \{\s*refuse\("The delivery note changed while this delivery was being completed\./);
  // And which note that is: the NEWEST one, signed or not — a note opened after
  // an earlier signature means the handover changed, so there is no signed note
  // until the customer signs the new one.
  const standing = noteSigningSource.slice(noteSigningSource.indexOf("const newestNoteStanding = "), noteSigningSource.indexOf("export async function signedDeliveryNote("));
  assert.match(standing, /orderBy: \{ createdAt: "desc" \}/);
  // Asked through the delivery's raw transaction as well, where no scoped
  // client adds the tenant or hides a trashed row — so the query says both.
  assert.match(standing, /subjectId: quoteId,\s*tenantId,\s*deletedAt: null,/);
  const lookup = noteSigningSource.slice(noteSigningSource.indexOf("export async function signedDeliveryNote("));
  assert.match(lookup, /tx\.signatureRequest\.findFirst\(newestNoteStanding\(quoteId, tenantId\)\)\s*: prisma\.signatureRequest\.findFirst\(newestNoteStanding\(quoteId, tenantId\)\)/, "one question, whichever client asks it");
  assert.match(lookup, /const signer = newest\?\.recipients\.find\(\(recipient\) => recipient\.status === "signed"\);/);
  assert.match(lookup, /if \(!newest \|\| !signer \|\| !facts\) return null;/);
});

test("the guided UI reviews the actual delivery note before showing signature", () => {
  const reviewAt = completionSource.indexOf("Delivery note preview");
  const continueAt = completionSource.indexOf("Delivery note reviewed — continue");
  const signatureAt = completionSource.indexOf("Customer signature");
  assert.ok(reviewAt >= 0);
  assert.ok(continueAt > reviewAt);
  assert.ok(signatureAt > continueAt);
  assert.match(completionSource, /`\/quotes\/\$\{quoteId\}\/delivery-note\?runs=/);
  assert.match(completionSource, /previewHref = `\/quotes\/\$\{quoteId\}\/delivery-note\?embed=1&runs=\$\{encodeURIComponent\(runs\)\}`/);
  assert.match(completionSource, /src=\{previewHref\}/);
  assert.match(completionSource, /action=\{markDelivered\.bind\(null, quoteId\)\}/);
});

test("embedded delivery-note review hides its nested print toolbar", () => {
  assert.match(deliveryNoteSource, /embed\?: string/);
  assert.match(deliveryNoteSource, /const embedded = embed === "1"/);
  assert.match(deliveryNoteSource, /\{!embedded && <PrintActions/);
});

test("the delivery note shows the guided snapshots being signed, then the stored signature", () => {
  const loaderSource = deliveryEvidenceSource;
  assert.match(deliveryNoteSource, /await loadDeliveryEvidence\(quote, requestedRuns\)/);
  assert.match(loaderSource, /prisma\.checklistRun\.findMany/);
  assert.match(loaderSource, /hostType: "quote\.delivery"/);
  assert.match(loaderSource, /labelSnapshot/);
  assert.match(loaderSource, /captureSnapshot/);
  // The selection moved into deliveryNoteRuns so it could be executed rather
  // than described — and so the note stops re-deciding, after signing, which run
  // the customer signed against.
  assert.match(loaderSource, /deliveryNoteRuns\(guidedRuns, noteRunIds\)/);
  assert.match(loaderSource, /tag: "delivery-signature"/);
  assert.match(deliveryNoteSource, /src=\{`\/api\/files\/\$\{signatureDoc\.id\}`\}/);
});

test("Deliveries uses the old proof-of-delivery only as an unconfigured fallback", () => {
  assert.match(pageSource, /handover\?\.configured \? \(/);
  assert.match(pageSource, /handover\.ready \? \(/);
  assert.match(pageSource, /<GuidedDeliveryCompletion quoteId=\{quote\.id\} runIds=\{handoverRuns\} signing=\{checklist\.signing\} \/>/);
  assert.match(pageSource, /No guided delivery checklist is configured/);
  assert.match(pageSource, /<ProofOfDelivery quoteId=\{quote\.id\} signing=\{checklist\.signing\} \/>/);
});

/*
 * THE SIGNED DELIVERY NOTE MUST NOT CHANGE AFTER IT IS SIGNED.
 *
 * The note chose the newest completed run per template on EVERY render, and a
 * delivery checklist is repeatable by design. So re-running one after handover
 * silently replaced the evidence printed beside a signature the customer had
 * already given. The per-entry snapshots froze the template's WORDING; nothing
 * froze WHICH RUN, which is the half that actually carries the findings.
 */

const run = (id: string, templateId: string, completedAt: string | null, sortOrder = 0) => ({
  id,
  templateId,
  completedAt: completedAt ? new Date(completedAt) : null,
  template: { sortOrder },
});

test("a run completed AFTER signing cannot appear on the signed note", () => {
  const atSigning = run("run_signed", "tpl_a", "2026-08-01T10:00:00Z");
  const rerunLater = run("run_rerun", "tpl_a", "2026-09-01T10:00:00Z");
  // Newest first, exactly as the page queries them.
  const rows = [rerunLater, atSigning];

  const shown = deliveryNoteRuns(rows, ["run_signed"]);
  assert.deepEqual(shown.map((r) => r.id), ["run_signed"], "the newer run must not displace the signed one");
});

test("the signed set is the WHOLE answer, not a preference", () => {
  // A template whose run is not in the signed set contributes nothing — the note
  // shows what was signed, never what merely exists now.
  const rows = [run("run_b_new", "tpl_b", "2026-09-01T10:00:00Z", 1), run("run_a", "tpl_a", "2026-08-01T10:00:00Z", 0)];
  assert.deepEqual(deliveryNoteRuns(rows, ["run_a"]).map((r) => r.id), ["run_a"]);
});

test("signed runs are ordered by the template's own order, not by recency", () => {
  const rows = [run("run_second", "tpl_b", "2026-08-02T10:00:00Z", 2), run("run_first", "tpl_a", "2026-08-01T10:00:00Z", 1)];
  assert.deepEqual(
    deliveryNoteRuns(rows, ["run_first", "run_second"]).map((r) => r.id),
    ["run_first", "run_second"],
  );
});

test("with nothing signed it behaves exactly as before", () => {
  // Deliveries completed before the ids existed, and notes not yet signed. Both
  // keep the newest-completed-per-template selection: the first must reproduce
  // what it renders today, and the second has nothing frozen to honour yet.
  const rows = [
    run("run_new", "tpl_a", "2026-09-01T10:00:00Z", 0),
    run("run_old", "tpl_a", "2026-08-01T10:00:00Z", 0),
    run("run_b", "tpl_b", "2026-08-05T10:00:00Z", 1),
  ];
  assert.deepEqual(deliveryNoteRuns(rows, []).map((r) => r.id), ["run_new", "run_b"]);
});

test("an incomplete run is never shown, signed or not", () => {
  const rows = [run("run_open", "tpl_a", null), run("run_done", "tpl_a", "2026-08-01T10:00:00Z")];
  assert.deepEqual(deliveryNoteRuns(rows, []).map((r) => r.id), ["run_done"]);
});

/* The wiring: pinning at signing, and re-verifying what was pinned. */

test("completion records the runs it validated, in the same write as the delivery", () => {
  // Validated when the customer is handed the note, frozen into it, and read
  // back from it at completion.
  assert.match(noteSigningSource, /select: \{ id: true, templateId: true, completedAt: true \}/, "the ids must be selected to be pinned");
  assert.match(noteSigningSource, /orderBy: \{ completedAt: "desc" \}/, "newest-first is what makes the choice deterministic");
  assert.match(noteSigningSource, /delivery: \{ \.\.\.\(ctx\.vars\.delivery as object\), runIds: facts\.runIds, checklist: facts\.checklist \}/, "the verified ids are frozen into the note that is signed");
  assert.match(noteSigningSource, /const \{ driver, runIds, checklist \} = delivery as/, "and read back from it, by the server");

  const fulfilment = deliverySource;
  assert.match(fulfilment, /deliveryHandoverRunIds\s*\}/, "they must land in the delivery update itself");
});

test("the ids are re-verified against the quote, never trusted", () => {
  // They come from the signed note now, and are still checked: a run can be
  // removed after the note froze it — and a delivery recorded against a partial
  // set is worse than none.
  const fulfilment = deliverySource;
  assert.match(fulfilment, /hostType: "quote\.delivery",\s*\n\s*hostId: quoteId,/, "scoped to THIS quote");
  assert.match(fulfilment, /completedAt: \{ not: null \}/, "and to completed runs only");
  // The de-duplication moved into `requestedRunIds` when the readiness gate was
  // added, so both sides of this comparison could be reused by it.
  assert.match(fulfilment, /verifiedRuns\.length !== requestedRunIds\.length/, "a partial match must refuse");
});

test("the note never re-derives the selection for itself", () => {
  const page = deliveryEvidenceSource;
  assert.match(page, /deliveryNoteRuns\(guidedRuns, noteRunIds\)/);
  assert.doesNotMatch(page, /latestRunByTemplate/, "a second copy of the rule is how the two drift apart");
  assert.doesNotMatch(deliveryNoteSource, /latestRunByTemplate|deliveryNoteRuns\(/, "nor may the page keep its own");
});

/*
 * THE GATE MUST HOLD FOR A DIRECT CALL, NOT ONLY THROUGH THE SCREEN.
 *
 * markDelivered is an exported Server Action, which is a public POST endpoint. A
 * stale legacy form or a hand-made request reaches it whatever the screen was
 * showing — so a readiness check that lives only in what the screen offers is
 * optional, which is the same as absent. It would record a delivery as signed
 * with an EMPTY deliveryHandoverRunIds and no checklist behind it.
 *
 * A Server Action's arguments are deserialised from the request, so run ids
 * passed to it were client-supplied too — which is why it takes none now: they
 * come from the note the customer signed. Re-verifying each is still necessary
 * and still not sufficient: one genuine run while a second configured checklist
 * is unfinished would be partial evidence.
 */
test("the legacy delivery action enforces the guided gate itself", () => {
  const fulfilment = deliverySource;

  assert.match(
    fulfilment,
    /prisma\.checklistTemplate\.findMany\(\{\s*\n\s*where: \{ tenantId, host: "quote\.delivery", active: true \}/,
    "markDelivered must look up the tenant's own configured handover",
  );
  assert.match(
    fulfilment,
    /deliveryHandoverReadiness\(handoverTemplates, verifiedRuns\)/,
    "and require the SAME readiness the guided wrapper does",
  );
  assert.match(fulfilment, /This delivery uses a guided handover\./, "with a refusal that says where to go");
});

test("readiness is judged on VERIFIED runs, never on what the caller claimed", () => {
  const fulfilment = deliverySource;
  const gate = fulfilment.slice(fulfilment.indexOf("const requestedRunIds"));

  // The database lookup must come first, and readiness must be judged on its
  // result — otherwise a caller naming ids it does not own satisfies the gate.
  const verify = gate.indexOf("prisma.checklistRun.findMany");
  const readiness = gate.indexOf("deliveryHandoverReadiness(");
  assert.ok(verify !== -1 && verify < readiness, "verify before judging readiness");
  assert.match(gate, /hostId: quoteId,/, "scoped to this quote");
  assert.match(gate, /completedAt: \{ not: null \}/, "completed runs only");
  assert.match(
    gate,
    /verifiedRuns\.length !== requestedRunIds\.length/,
    "an id that does not resolve must refuse, not be dropped",
  );
  assert.match(
    gate,
    /verifiedRuns\.length !== handoverTemplates\.length/,
    "extra genuine runs must not make the signed evidence ambiguous",
  );
  assert.match(
    gate,
    /else if \(requestedRunIds\.length > 0\)/,
    "a tenant with no active handover must not store caller-supplied run ids",
  );
});

test("a tenant with no configured handover keeps the legacy flow", () => {
  // The gate is scoped to what the tenant actually configured. No active
  // template means no guided handover, and proof-of-delivery is untouched.
  const fulfilment = deliverySource;
  assert.match(fulfilment, /if \(handoverTemplates\.length > 0\) \{/, "the gate must be conditional on configuration");

  // Stated as behaviour too: with no templates, readiness reports unconfigured
  // rather than complete, so nothing here can read it as a silent pass.
  assert.deepEqual(deliveryHandoverReadiness([], []), {
    configured: false,
    ready: false,
    missingTemplateIds: [],
  });
});

test("a partial set of genuine runs is still refused", () => {
  // The case re-verification alone would have let through.
  const templates = [{ id: "tpl_a" }, { id: "tpl_b" }];
  const onlyOneDone = [{ templateId: "tpl_a", completedAt: new Date() }];
  const readiness = deliveryHandoverReadiness(templates, onlyOneDone);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missingTemplateIds, ["tpl_b"]);
});

/*
 * A REFUSAL MUST NOT LEAVE ANYTHING BEHIND.
 *
 * The gate was correct but ran too late: markDelivered stored the optional
 * delivery-note file and the customer-signature document BEFORE checking
 * readiness. A stale or crafted legacy request was refused — and had already
 * uploaded a blob and created Document rows for a delivery that never
 * completed. Nothing cleans those up, so every rejected attempt left litter in
 * storage attached to a real quote.
 *
 * The gate only reads, so it costs nothing to run first.
 *
 * Since both delivery buttons share deliverQuote, the paperwork is stored by the
 * board's `collectEvidence` callback, which deliverQuote calls only after its
 * gates. So: every write in deliverQuote comes after the gate, and every write
 * in markDelivered lives inside that callback.
 */
test("the guided gate runs before the delivery writes anything", () => {
  const start = deliverySource.indexOf("export async function deliverQuote(");
  assert.notEqual(start, -1, "deliverQuote not found — was it renamed?");
  const after = deliverySource.slice(start + 1);
  const next = after.indexOf("\nexport async function ");
  const body = next === -1 ? after : after.slice(0, next);

  const gate = body.indexOf("deliveryHandoverReadiness(handoverTemplates, verifiedRuns)");
  assert.notEqual(gate, -1, "the readiness gate must be inside deliverQuote");

  for (const [what, needle] of [
    ["the caller's paperwork", "input.collectEvidence("],
    ["the delivery itself", "tx.quote.updateMany("],
    ["the stock hand-over", "tx.stockUnit.updateMany("],
    ["the vehicle record", "tx.vehicle.create("],
  ] as const) {
    const at = body.indexOf(needle);
    assert.notEqual(at, -1, `${what} not found — has deliverQuote been restructured?`);
    assert.ok(at > gate, `${what} must not run before the guided gate — a refusal would leave it behind`);
  }

  // And the id verification must precede the gate that judges it.
  const verify = body.indexOf("prisma.checklistRun.findMany(");
  assert.ok(verify !== -1 && verify < gate, "ids are verified, then judged");

  // markDelivered writes nothing itself: it only STAGES its paperwork, inside
  // the callback deliverQuote runs late, and deliverQuote files it.
  const board = readFileSync("src/app/actions/fulfilment.ts", "utf8");
  const md = board.slice(board.indexOf("export async function markDelivered("));
  const callback = md.indexOf("collectEvidence: async (quote, stage)");
  assert.notEqual(callback, -1, "markDelivered must hand its paperwork to deliverQuote as a callback");
  assert.ok(md.indexOf("await stage(") > callback, "files are staged inside collectEvidence");
  for (const write of [/attachStageDocument\(/, /saveFile\(/, /document\.create\(/, /prisma\.quote\.updateMany\(/]) {
    assert.doesNotMatch(md, write, "the delivery's writes belong to deliverQuote alone");
  }
});

/* ── the note reviewed is the note signed ────────────────────────────────── */

/*
 * "The newest completed run per template" is an answer that CHANGES, and it was
 * being asked twice: once by the delivery note when the customer previewed it,
 * and again by completeGuidedDelivery at submission. A colleague finishing
 * another checklist in between changed the answer, so the customer reviewed run
 * A and their signature was filed beside run B — the one thing a signature is
 * supposed to make impossible.
 */

const pick = (id: string, templateId: string, completedAt: string | null) => ({ id, templateId, completedAt });

test("ONE SELECTION, newest completed run per template, in template order", () => {
  const templates = [{ id: "t1" }, { id: "t2" }];
  const runs = [
    pick("r-old", "t1", "2026-08-01T10:00:00Z"),
    pick("r-new", "t1", "2026-08-02T10:00:00Z"),
    pick("r-two", "t2", "2026-08-01T09:00:00Z"),
    pick("r-unfinished", "t2", null),
  ];
  assert.deepEqual(handoverRunSelection(templates, runs), ["r-new", "r-two"]);
});

test("the selection does not depend on the order the caller fetched in", () => {
  // Two callers with different orderBy clauses must not pin different runs.
  const templates = [{ id: "t1" }];
  const ascending = [pick("r-old", "t1", "2026-08-01T10:00:00Z"), pick("r-new", "t1", "2026-08-02T10:00:00Z")];
  const descending = [...ascending].reverse();
  assert.deepEqual(handoverRunSelection(templates, ascending), handoverRunSelection(templates, descending));
});

test("equal completion timestamps are resolved deterministically", () => {
  const templates = [{ id: "t1" }];
  const first = [pick("run_b", "t1", "2026-08-01T10:00:00Z"), pick("run_a", "t1", "2026-08-01T10:00:00Z")];
  assert.deepEqual(handoverRunSelection(templates, first), ["run_a"]);
  assert.deepEqual(handoverRunSelection(templates, [...first].reverse()), ["run_a"]);
});

test("A RUN COMPLETED DURING REVIEW CANNOT REPLACE THE ONE ON SCREEN", () => {
  /*
   * The whole defect, as data. The screen pins its selection, then a colleague
   * finishes a newer run. Re-deriving would move the note; honouring the pinned
   * ids does not.
   */
  const templates = [{ id: "t1" }];
  const atReview = [pick("r-reviewed", "t1", "2026-08-01T10:00:00Z")];
  const pinned = handoverRunSelection(templates, atReview);
  assert.deepEqual(pinned, ["r-reviewed"]);

  const atSigning = [...atReview, pick("r-later", "t1", "2026-08-01T10:05:00Z")];
  assert.deepEqual(
    handoverRunSelection(templates, atSigning),
    ["r-later"],
    "re-deriving would indeed have moved — which is why it must not be re-derived",
  );

  // deliveryNoteRuns honours the pinned ids over anything newer.
  const withTemplate = atSigning.map((r) => ({ ...r, template: { sortOrder: 0 } }));
  assert.deepEqual(
    deliveryNoteRuns(withTemplate, pinned).map((r) => r.id),
    ["r-reviewed"],
  );
});

test("the iframe and the form carry the SAME ids", () => {
  // If these two ever came from different expressions, the property above would
  // be true of the library and false of the screen.
  assert.match(completionSource, /const runs = runIds\.join\(","\);/);
  assert.match(completionSource, /previewHref = `\/quotes\/\$\{quoteId\}\/delivery-note\?embed=1&runs=\$\{encodeURIComponent\(runs\)\}`/);
  assert.match(completionSource, /<input type="hidden" name="runIds" value=\{runs\} \/>/);
  // …and the page computes them ONCE for both layouts.
  assert.match(pageSource, /const handoverRuns = checklist \? handoverRunSelection\(checklist\.templates, checklist\.runs\) : \[\];/);
  assert.equal(
    (pageSource.match(/runIds=\{handoverRuns\}/g) ?? []).length,
    2,
    "mobile and desktop must pin the same runs for the same delivery",
  );
});

test("THE SUBMITTED IDS ARE VERIFIED, NOT TRUSTED", () => {
  /*
   * They travel through the browser. What the check permits is the point: only
   * runs already belonging to this quote, in this tenant, against an active
   * delivery template, and complete — so a forged value can pick a different one
   * of the customer's own completed runs and nothing else.
   */
  assert.match(startSource, /const claimedRunIds = String\(formData\.get\("runIds"\) \?\? ""\)/);
  const verify = noteSigningSource.slice(
    noteSigningSource.indexOf("export async function reviewedHandoverRuns("),
    noteSigningSource.indexOf("function handoverFactsOf("),
  );
  assert.match(verify, /const completedById = new Map\(runs\.filter\(\(run\) => run\.completedAt\)/);
  assert.match(
    verify,
    /if \(!run \|\| seenTemplates\.has\(run\.templateId\)\) throw new ActionRefusal\(CHANGED\);/,
    "an unknown id must be refused — and so must two runs for one template, which would make the signed document ambiguous",
  );
  assert.match(
    verify,
    /if \(templates\.some\(\(template\) => !seenTemplates\.has\(template\.id\)\)\) throw new ActionRefusal\(CHANGED\);/,
    "a short list must not get a signature against a partial handover",
  );
  assert.match(verify, /return \{ guided: true, runIds: claimed \};/);
  // What was verified is what gets frozen — the action hands on the verified
  // list, not the one the browser sent.
  assert.match(startSource, /facts: \{ deliveredByName, runIds: handover\.runIds, checklist \}/);
  // Neither may make its own choice of runs — and nor may the delivery.
  assert.doesNotMatch(startSource + noteSigningSource + deliverySource, /signedByTemplate|handoverRunSelection\(/, "the selection must not be re-derived on the server");
});

test("a signed note ignores the query parameter entirely", () => {
  // Once recorded, the stored ids are the whole answer — a link cannot restyle
  // a document somebody has already signed.
  assert.match(
    deliveryEvidenceSource,
    /quote\.deliveryHandoverRunIds\.length > 0\s*\r?\n?\s*\? quote\.deliveryHandoverRunIds/,
  );
  // And an unsigned preview only honours ids that are already this quote's runs.
  assert.match(deliveryEvidenceSource, /previewRunIds\.filter\(\(id\) => guidedRuns\.some\(\(run\) => run\.id === id\)\)/);
});
