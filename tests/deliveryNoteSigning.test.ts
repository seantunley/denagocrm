/**
 * The delivery note, signed by the customer on a screen at handover.
 *
 * The customer used to sign a box drawn inside the CRM's own delivery form: a
 * picture of a signature, filed beside a note that was re-drawn from the live
 * record every time it was opened. They now sign the delivery note itself, as a
 * signature request ABOUT the delivery — frozen, sealed, and witnessed by the
 * member of staff who handed the vehicle over. These pin what that has to get
 * right:
 *
 *   - signing the note is NOT delivering: it files the sealed note under the
 *     quote and touches nothing else on it;
 *   - what the customer reads is frozen with the request — photos as references;
 *   - whoever may manage the delivery may run it, not whoever holds the
 *     Signatures permission, and reading the signing page makes nothing;
 *   - no screen can draw or post a signature any more.
 *
 * The delivery reading its evidence back from the signed note is pinned in
 * guidedDeliveryHandover.test.ts and oneDeliveryFlow.test.ts. What only a
 * database can show is in scripts/test-delivery-note-signing.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryNoteSigning } from "../src/components/signing/deliveryNoteSigning";
import { deliveryTemplateForScreen, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { DELIVERY_NOTE, TEST_DRIVE_INDEMNITY } from "../src/lib/signing/subject";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Line endings normalised: a Windows checkout has CRLF, CI has LF.
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
/** Without comments, so a rule described in prose is not mistaken for one that is enforced. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const fnBody = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — was it renamed?`);
  // "\n}\n" and not "\n}": an options type in the signature closes with "\n}): …".
  return source.slice(start, source.indexOf("\n}\n", start));
};

// ── What the customer is shown ──────────────────────────────────────────────

test("the standard delivery note for a screen drops only the lines that need a pen", () => {
  const printed = JSON.stringify(standardTemplateFor("delivery"));
  const screen = JSON.stringify(deliveryTemplateForScreen());
  assert.match(printed, /_{20,}/, "the printed note still has its ruled sign-off lines");
  assert.match(printed, /Driver & date/);
  assert.doesNotMatch(screen, /_{10,}/, "a ruled line nobody can sign on would sit above the real signature box");
  assert.doesNotMatch(screen, /Driver & date/, "the driver does not sign here: they are named on the note and are its witness");
  assert.match(screen, /Received in good order\./, "what the customer is signing for is still said");
  // Everything else is the same note: who, what, and how it was handed over.
  for (const part of ["{{delivery.number}}", "{{delivery.meta}}", "{{customer.name}}", "{{delivery.deliverTo}}", "{{delivery.details}}", '"type":"lineItems"', '"type":"handoverChecklist"']) {
    assert.ok(printed.includes(part) && screen.includes(part), `${part} is on both`);
  }
});

test("it draws no signature box of its own: a packing list and photos end at no fixed place", () => {
  // The engine adds a page for the customer's signature and date. A box at fixed
  // coordinates would land on top of a long checklist, or far below a short one.
  const doc = deliveryTemplateForScreen();
  assert.equal(doc.recipients.length, 0);
  assert.equal(doc.pages.flatMap((page) => page.overlayFields).length, 0);
  const prepare = fnBody(code("src/lib/deliveryNoteSigning.ts"), "prepareDeliveryNote");
  assert.match(prepare, /const signable = signedByCustomerOnly\(layout, \{ staff: \{ name: user\.name, email: user\.email \?\? null \}, customer \}\);/);
  assert.match(code("src/lib/signing/subjectRequests.ts"), /return \{ doc: ensureSignable\(layout, people\.customer\) \};/);
});

test("the delivery screens are told where the signature stands, and nothing they could act on", () => {
  assert.deepEqual(deliveryNoteSigning({ kind: "none" }), { kind: "none" });
  // The engine's state names the request and the signer. A client component gets neither.
  const open = { kind: "open" as const, requestId: "req_1", recipientId: "rcp_1", startedAt: new Date() };
  assert.deepEqual(deliveryNoteSigning(open), { kind: "open" });
  // Signed is signed, whether or not the sealed copy has been filed yet: the
  // delivery does not wait at the kerb for a PDF.
  assert.deepEqual(deliveryNoteSigning({ kind: "finishing", signedByName: "Naledi Dlamini" }), { kind: "signed", signedByName: "Naledi Dlamini", sealed: false });
  const done = { kind: "signed" as const, requestId: "req_1", signedByName: "Naledi Dlamini", signedAt: new Date() };
  assert.deepEqual(deliveryNoteSigning(done), { kind: "signed", signedByName: "Naledi Dlamini", sealed: true });
  // Computed on the server, once per delivery that is ready to hand over.
  const page = code("src/app/(app)/deliveries/page.tsx");
  assert.match(page, /checklistByQuote\.set\(quote\.id, \{ templates, runs, signing: deliveryNoteSigning\(note\) \}\);/);
  assert.match(page, /quotes\.filter\(\(quote\) => colOf\(quote\) === "deliver"\)/);
});

// ── Frozen with the request ─────────────────────────────────────────────────

test("the note is made from the record as it is now, and frozen — photos as references", () => {
  const prepare = fnBody(code("src/lib/deliveryNoteSigning.ts"), "prepareDeliveryNote");
  // The customer is signing for receipt, now: the date on the note is today's,
  // not a delivery date nobody has recorded yet.
  assert.match(prepare, /deliveredAt: new Date\(\),/);
  assert.match(prepare, /deliveredByName: facts\.deliveredByName,/);
  // Megabytes of photo do not belong in a request row.
  assert.match(prepare, /await handoverRuns\(facts\.runIds\.length > 0 \? guidedRunsForNote : \[\], facts\.checklist, regional, \(url\) => url\)/);
  assert.match(prepare, /context,\s*contactId: person\?\.id \?\? null,/, "frozen with the request");
  // …and they are embedded when the note is drawn, in the request's own workspace.
  const render = code("src/lib/signing/render.ts");
  assert.match(render, /photos: \(await Promise\.all\(\(entry\.photos \?\? \[\]\)\.map\(\(ref\) => embedStoredImage\(ref, tenantId\)\)\)\)\.filter\(/);
  assert.match(render, /return withCompany\(await frozenContext\(opts\?\.context, opts\?\.tenantId\)\);/);
});

test("the note shows exactly the runs that were reviewed — the same ones, not merely as many", () => {
  // Asked for runs it cannot find, the evidence loader falls back to the newest
  // completed run per checklist. Counting would let that different note through.
  const prepare = fnBody(code("src/lib/deliveryNoteSigning.ts"), "prepareDeliveryNote");
  assert.match(prepare, /const shown = new Set\(guidedRunsForNote\.map\(\(run\) => run\.id\)\);/);
  assert.match(prepare, /if \(facts\.runIds\.length > 0 && \(shown\.size !== facts\.runIds\.length \|\| !facts\.runIds\.every\(\(id\) => shown\.has\(id\)\)\)\) \{\s*throw new ActionRefusal\(/);
  assert.ok(prepare.indexOf("const shown = new Set(") < prepare.indexOf("await toPdf("), "refused before anything is rendered or stored");
});

// ── Signing it is not delivering ────────────────────────────────────────────

test("a delivery note is about the quote, and is not the quote's own request", () => {
  // `quoteId` on a request means "this IS the quote": completing it marks the
  // quote accepted and wins the lead. Receiving the goods is another signature.
  assert.equal(DELIVERY_NOTE, "delivery_note", "the stored value: changing it orphans every delivery note already made");
  assert.notEqual(DELIVERY_NOTE, TEST_DRIVE_INDEMNITY);
  const note = code("src/lib/deliveryNoteSigning.ts");
  assert.match(note, /const noteOf = \(quoteId: string\) => \(\{ type: DELIVERY_NOTE, id: quoteId \}\);/);
  assert.match(fnBody(note, "prepareDeliveryNote"), /subject: noteOf\(quoteId\),/);
  assert.match(code("src/lib/signing/subjectRequests.ts"), /source: \{ contactId: opts\.contactId, subject \},/, "no quoteId is ever handed to the request");
});

test("completing the note files it under the quote, in its own workspace, and does nothing else to the quote", () => {
  const hooks = code("src/lib/signing/subjectCompletion.ts");
  assert.match(hooks, /FROM "Quote" WHERE id = \$\{req\.subjectId\} AND "tenantId" = \$\{req\.tenantId\} FOR UPDATE/, "the quote's row first — the order the delivery takes");
  const mark = fnBody(hooks, "completeSubject");
  const branch = mark.slice(mark.indexOf("if (req.subjectType === DELIVERY_NOTE) {"));
  assert.match(branch, /if \(!signedDocumentId\) return false;/);
  // One statement. subjectId has no foreign key, so the workspace is named on
  // the document AND on the quote it is being filed under.
  assert.match(branch, /UPDATE "Document" d\s+SET "quoteId" = \$\{req\.subjectId\}, "tag" = 'delivery-note'/);
  assert.match(branch, /WHERE d\."id" = \$\{signedDocumentId\} AND d\."tenantId" = \$\{req\.tenantId\}/);
  assert.match(branch, /AND EXISTS \(SELECT 1 FROM "Quote" q WHERE q\."id" = \$\{req\.subjectId\} AND q\."tenantId" = \$\{req\.tenantId\}\)/);
  assert.match(branch, /return filed === 1;/);
  // Marking a quote delivered moves stock and makes vehicles, behind gates only
  // a member of staff can answer for. A customer's signature must not do it.
  assert.doesNotMatch(branch, /UPDATE "Quote"|tx\.quote\.|deliveredAt|deliverQuote/, "nothing is written to the quote");
  assert.doesNotMatch(mark, /throw/, "a receipt stands whatever became of the quote — completing never refuses");
  // The sealed PDF's Document row is handed over from the same transaction.
  assert.match(code("src/lib/signing/complete.ts"), /subjectSigned = await completeSubject\(tx, req, document\?\.id \?\? null\);/);
});

test("a note can be signed for again until the delivery is completed, and only while there is one to complete", () => {
  const prepare = fnBody(code("src/lib/deliveryNoteSigning.ts"), "prepareDeliveryNote");
  // An indemnity is final once signed. A delivery note is evidence for a
  // delivery still to be completed: if the handover changes, the customer must
  // be able to sign for what is now true.
  assert.match(prepare, /again: true,/);
  assert.match(prepare, /holdRecord: async \(tx\) => \{\s*await tx\.\$executeRaw`SELECT id FROM "Quote" WHERE id = \$\{quoteId\} AND "tenantId" = \$\{tenantId\} FOR UPDATE`;/);
  assert.match(prepare, /return Boolean\(live && live\.status === "accepted" && !live\.deliveredAt && !live\.supersededAt && live\.deliveryScheduledFor\);/);
  // Only the customer signs it.
  assert.match(prepare, /if \("alsoAsks" in signable\) \{\s*throw new ActionRefusal\(/);
  assert.ok(prepare.indexOf('if ("alsoAsks" in signable)') < prepare.indexOf("await toPdf("), "refused before anything is rendered or stored");
});

test("a note left open and never signed goes with the delivery it was for", () => {
  const delivery = code("src/lib/quoteDelivery.ts");
  const tx = delivery.slice(delivery.indexOf("basePrisma.$transaction("), delivery.indexOf("const actor = {"));
  assert.match(tx, /withdrawnNotes = await withdrawOpenSubjectRequests\(tx, note, tenantId\);/, "inside the delivery's transaction, under the quote's lock");
  const after = delivery.slice(delivery.indexOf("const actor = {"));
  assert.match(after, /await recordSubjectWithdrawn\(withdrawnNotes, await staffActor\(user\.name, tenantId\), "delivery", "The delivery was completed without it"\)\.catch\(\(\) => \{\}\);/, "the evidence entry, once committed — never a reason to report a delivery as failed");
});

// ── Who may run it ──────────────────────────────────────────────────────────

test("it is the delivery's permission, not the Signatures one", () => {
  const action = code("src/app/actions/deliverySigning.ts");
  const start = fnBody(action, "startDeliveryNoteSigning");
  const order = ['requireModuleEnabled("automotive")', 'requireQuoteAccess(quoteId, "deliveries.manage")', "reviewedHandoverRuns(tenantId, quoteId, claimedRunIds)", "await prepareDeliveryNote("].map((step) => start.indexOf(step));
  assert.ok(order.every((at) => at !== -1), "module, this quote, the handover, then the note");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order: nothing is made before the delivery is checked");
  assert.match(start, /return asActionResult\(\(\) => withActingStaffScope\(async \(\) => \{/);
  assert.match(start, /return \{ redirectTo: `\/deliveries\/\$\{quoteId\}\/sign` \};/, "returned, not thrown: the button moves on only when it worked");

  const page = code("src/app/(handover)/deliveries/[id]/sign/page.tsx");
  const permission = page.indexOf('requirePermission("deliveries.manage")');
  const access = page.indexOf("canAccessQuote(user, id)");
  const screen = page.indexOf("<InPersonSigning");
  assert.ok(permission !== -1 && access !== -1 && screen !== -1);
  assert.ok(permission < access && access < screen, "permission, then THIS quote, then the screen that mints a pass");
  assert.match(page, /if \(!\(await isModuleEnabled\("automotive"\)\) \|\| !\(await canAccessQuote\(user, id\)\)\) notFound\(\);/, "one answer for 'no such quote' and 'not yours'");
  assert.match(page, /recipient\.tenantId !== quote\.tenantId/, "the signer is the quote's workspace's own");
  for (const source of [action, page]) assert.doesNotMatch(source, /signing\.manage|signing\.view/, "a driver needs no signing permission for this");
  // Reading the page makes nothing: a reload must show the same document, not a new one.
  assert.doesNotMatch(page, /prepareDeliveryNote|startDeliveryNoteSigning/);
  assert.ok(existsSync(path.join(root, "src/app/(handover)/layout.tsx")), "and it sits outside the CRM shell, with the other screens handed to a customer");
});

// ── No screen draws a signature any more ────────────────────────────────────

test("neither delivery screen can draw, hold or post a signature", () => {
  for (const file of ["src/components/ProofOfDelivery.tsx", "src/components/checklists/GuidedDeliveryCompletion.tsx"]) {
    const screen = code(file);
    assert.doesNotMatch(screen, /<canvas|toDataURL|name="signature"|getContext\(/, `${file} still has a signature box`);
    assert.match(screen, /<SignOnDeviceButton start=\{startDeliveryNoteSigning\.bind\(null, quoteId\)\}/, `${file} hands the device over through the signing engine`);
    assert.match(screen, /action=\{markDelivered\.bind\(null, quoteId\)\}/, `${file} completes through the one delivery action`);
  }
  // Asking the customer to sign again is the only thing offered while they are
  // being asked: no button there confirms the delivery against the old signature.
  const proof = code("src/components/ProofOfDelivery.tsx");
  assert.match(proof, /\{signed && again \? \(\s*<button type="button" onClick=\{\(\) => setAgain\(false\)\}/);
  assert.match(proof, /\{signed \? "✓ Confirm delivery → register vehicle" : "Confirm delivery without a signature → register vehicle"\}/);
});

test("the button that hands the device to a customer says nothing on success", () => {
  // A SaveForm toasts when it works, and the next screen is the customer's. A
  // CRM toast must not follow the device into their hands.
  const button = code("src/components/signing/SignOnDeviceButton.tsx");
  assert.match(button, /type="button"/);
  assert.match(button, /if \(form && !form\.reportValidity\(\)\) return;/, "a plain button skips the browser's own required check; this asks for it");
  assert.match(button, /if \(value instanceof File\) formData\.delete\(name\);/, "starting a signature never uploads what the form also holds");
  assert.match(button, /if \(!result\.error && result\.redirectTo\) return router\.push\(result\.redirectTo\);/);
  assert.doesNotMatch(button, /toast\.success|toast\(/, "refusals only");
  // One button for every document signed in person: the indemnity uses it too.
  assert.match(code("src/app/(app)/test-drives/[id]/page.tsx"), /<SignOnDeviceButton start=\{startTestDriveIndemnity\.bind\(null, bookingId\)\}/);
  assert.equal(existsSync(path.join(root, "src/app/(app)/test-drives/[id]/IndemnityStartButton.tsx")), false);
});
