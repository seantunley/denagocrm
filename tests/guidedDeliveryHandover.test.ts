import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deliveryHandoverReadiness, deliveryNoteRuns } from "../src/lib/checklists/deliveryHandover";

const actionSource = readFileSync("src/app/actions/guidedDelivery.ts", "utf8");
const pageSource = readFileSync("src/app/(app)/deliveries/page.tsx", "utf8");
const completionSource = readFileSync("src/components/checklists/GuidedDeliveryCompletion.tsx", "utf8");
const deliveryNoteSource = readFileSync("src/app/(print)/quotes/[id]/delivery-note/page.tsx", "utf8");

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

test("server completion repeats the checklist, review, driver and signature gates", () => {
  assert.match(actionSource, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(actionSource, /host: "quote\.delivery", active: true/);
  assert.match(actionSource, /hostType: "quote\.delivery"/);
  assert.match(actionSource, /deliveryNoteReviewed/);
  assert.match(actionSource, /deliveredByName/);
  assert.match(actionSource, /SIGNATURE_PREFIX/);
  assert.match(actionSource, /signatureBytes\.length > MAX_SIGNATURE_BYTES/);
  assert.match(actionSource, /deliveryHandoverReadiness\(templates, runs\)/);
  // Now carries the runs it pinned. The delegation is what this assertion is
  // for; the third argument is what makes the signed note immutable.
  assert.match(actionSource, /return markDelivered\(quoteId, formData, signedRunIds\)/);
});

test("the guided UI reviews the actual delivery note before showing signature", () => {
  const reviewAt = completionSource.indexOf("Delivery note preview");
  const continueAt = completionSource.indexOf("Delivery note reviewed — continue");
  const signatureAt = completionSource.indexOf("Customer signature");
  assert.ok(reviewAt >= 0);
  assert.ok(continueAt > reviewAt);
  assert.ok(signatureAt > continueAt);
  assert.match(completionSource, /`\/quotes\/\$\{quoteId\}\/delivery-note`/);
  assert.match(completionSource, /previewHref = `\$\{noteHref\}\?embed=1`/);
  assert.match(completionSource, /src=\{previewHref\}/);
  assert.match(completionSource, /completeGuidedDelivery\.bind\(null, quoteId\)/);
});

test("embedded delivery-note review hides its nested print toolbar", () => {
  assert.match(deliveryNoteSource, /embed\?: string/);
  assert.match(deliveryNoteSource, /const embedded = embed === "1"/);
  assert.match(deliveryNoteSource, /\{!embedded && <PrintActions/);
});

test("the delivery note shows the guided snapshots being signed, then the stored signature", () => {
  assert.match(deliveryNoteSource, /prisma\.checklistRun\.findMany/);
  assert.match(deliveryNoteSource, /hostType: "quote\.delivery"/);
  assert.match(deliveryNoteSource, /labelSnapshot/);
  assert.match(deliveryNoteSource, /captureSnapshot/);
  // The selection moved into deliveryNoteRuns so it could be executed rather
  // than described — and so the note stops re-deciding, after signing, which run
  // the customer signed against.
  assert.match(deliveryNoteSource, /deliveryNoteRuns\(guidedRuns, quote\.deliveryHandoverRunIds\)/);
  assert.match(deliveryNoteSource, /tag: "delivery-signature"/);
  assert.match(deliveryNoteSource, /src=\{`\/api\/files\/\$\{signatureDoc\.id\}`\}/);
});

test("Deliveries uses the old proof-of-delivery only as an unconfigured fallback", () => {
  assert.match(pageSource, /handover\?\.configured \? \(/);
  assert.match(pageSource, /handover\.ready \? \(/);
  assert.match(pageSource, /<GuidedDeliveryCompletion quoteId=\{quote\.id\} \/>/);
  assert.match(pageSource, /No guided delivery checklist is configured/);
  assert.match(pageSource, /<ProofOfDelivery quoteId=\{quote\.id\} \/>/);
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
  const guided = actionSource;
  assert.match(guided, /select: \{ id: true, templateId: true, completedAt: true \}/, "the ids must be selected to be pinned");
  assert.match(guided, /orderBy: \{ completedAt: "desc" \}/, "newest-first is what makes the choice deterministic");
  assert.match(guided, /markDelivered\(quoteId, formData, signedRunIds\)/, "the pinned ids must reach the write");

  const fulfilment = readFileSync("src/app/actions/fulfilment.ts", "utf8");
  assert.match(fulfilment, /deliveryHandoverRunIds\s*\}/, "they must land in the delivery update itself");
});

test("the ids are re-verified against the quote, never trusted", () => {
  // They arrive server-to-server, but a caller inside the process is still a
  // caller — and a note signed against a partial set is worse than none.
  const fulfilment = readFileSync("src/app/actions/fulfilment.ts", "utf8");
  assert.match(fulfilment, /hostType: "quote\.delivery",\s*\n\s*hostId: quoteId,/, "scoped to THIS quote");
  assert.match(fulfilment, /completedAt: \{ not: null \}/, "and to completed runs only");
  // The de-duplication moved into `requestedRunIds` when the readiness gate was
  // added, so both sides of this comparison could be reused by it.
  assert.match(fulfilment, /verifiedRuns\.length !== requestedRunIds\.length/, "a partial match must refuse");
});

test("the note never re-derives the selection for itself", () => {
  const page = deliveryNoteSource;
  assert.match(page, /deliveryNoteRuns\(guidedRuns, quote\.deliveryHandoverRunIds\)/);
  assert.doesNotMatch(page, /latestRunByTemplate/, "a second copy of the rule is how the two drift apart");
});

/*
 * THE GATE MUST HOLD FOR A DIRECT CALL, NOT ONLY THROUGH THE WRAPPER.
 *
 * markDelivered is an exported Server Action, which is a public POST endpoint. A
 * stale legacy form or a hand-made request reaches it without going anywhere
 * near completeGuidedDelivery — so a readiness check that lives only in the
 * wrapper is optional, which is the same as absent. It would record a delivery
 * as signed with an EMPTY deliveryHandoverRunIds and no checklist behind it.
 *
 * And a Server Action's arguments are deserialised from the request, so the run
 * ids are client-supplied too. Re-verifying each id is necessary but not
 * sufficient: a caller could pass one genuine run while a second configured
 * checklist was still unfinished, and be recorded with partial evidence.
 */
test("the legacy delivery action enforces the guided gate itself", () => {
  const fulfilment = readFileSync("src/app/actions/fulfilment.ts", "utf8");

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
  const fulfilment = readFileSync("src/app/actions/fulfilment.ts", "utf8");
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
});

test("a tenant with no configured handover keeps the legacy flow", () => {
  // The gate is scoped to what the tenant actually configured. No active
  // template means no guided handover, and proof-of-delivery is untouched.
  const fulfilment = readFileSync("src/app/actions/fulfilment.ts", "utf8");
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
