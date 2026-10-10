/**
 * THE DELIVERY NOTE, SIGNED ON A SCREEN — what the database actually does.
 *
 * The customer used to sign a box inside the CRM's delivery form. They now sign
 * the delivery note itself, as a signature request about the delivery, and the
 * delivery is then recorded against what that note froze. The unit tests pin the
 * order of the steps; these are the parts that only exist against a real
 * database, with tenant enforcement on, the real signing route and the real
 * delivery (lib/quoteDelivery.ts):
 *
 *   - the note is ABOUT the quote and is not the quote's own request — signing
 *     it must not mark the quote accepted again, win a lead, or deliver anything;
 *   - what the customer reads is frozen: the packing list, who handed over, the
 *     checklist — and the handover photos are kept as references and embedded
 *     only when the note is drawn;
 *   - the reviewed checklist runs are verified against this quote, in this
 *     workspace, one per active checklist, before any note is made;
 *   - once sealed, the note is filed under the quote;
 *   - a note opened after an earlier signature takes over: there is no signed
 *     note again until the customer signs the new one;
 *   - the delivery reads its evidence from the signed note and from nowhere
 *     else, refuses a guided handover without one, and proves the note again
 *     under the quote's lock — a note opened, or signed, while the delivery is
 *     being completed stops it.
 *
 * Sealing needs a browser process. Where there is none the signature still
 * stands and the filing step is run directly; the script says which happened.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Signing
 * evidence is append-only, so the rows stay behind in workspaces of their own.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { ActionRefusal } from "../src/lib/actionFailure";
import { readFile, saveFile } from "../src/lib/storage";
import {
  deliveryNoteState,
  prepareDeliveryNote,
  reviewedHandoverRuns,
  signedDeliveryNote,
  withdrawOpenDeliveryNote,
  type HandoverFacts,
} from "../src/lib/deliveryNoteSigning";
import { deliverQuote } from "../src/lib/quoteDelivery";
import { completeSubject, lockSubject } from "../src/lib/signing/subjectCompletion";
import { DELIVERY_NOTE } from "../src/lib/signing/subject";
import { renderRequestDocHtml } from "../src/lib/signing/render";
import { usableCapability } from "../src/lib/signing/tokenVault";
import { mintInPersonPass } from "../src/lib/signing/inPerson";
import { POST as signRoute } from "../src/app/api/signing/[token]/route";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

// A 1×1 PNG: the smallest thing the route accepts as a drawn signature, and a handover photo.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SIGNATURE = `data:image/png;base64,${PNG_BASE64}`;
const standInPdf = async () => Buffer.from("%PDF-1.4\n% stand-in for the unsigned copy, which a browser process renders\n");
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    if (error instanceof ActionRefusal) return error.message;
    throw error;
  }
}

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);

  const workspace = async (label: string) => {
    const tenantId = `dn_${label}_${SFX}`;
    await basePrisma.tenant.create({ data: { id: tenantId, name: `Delivery ${label} ${SFX}`, slug: tenantId, active: true, modules: "automotive" } });
    const user = await basePrisma.user.create({
      data: { id: `dn_rep_${label}_${SFX}`, name: `Driver ${label} ${SFX}`, email: `dn-rep-${label}-${SFX}@example.test`, passwordHash: "x", role: "sales", tenantId },
    });
    await basePrisma.tenantMember.create({ data: { tenantId, userId: user.id } });
    return { tenantId, rep: { id: user.id, name: user.name, email: user.email, role: user.role } };
  };
  const { tenantId, rep } = await workspace("a");
  const other = await workspace("b");
  const inScope = <T>(work: () => Promise<T>, tenant = tenantId) => runInTenantScope({ tenantId: tenant, system: false }, work);

  const customer = `Naledi Dlamini${SFX}`;
  const contact = await basePrisma.contact.create({
    data: { firstName: "Naledi", lastName: `Dlamini${SFX}`, email: `naledi-${SFX}@example.test`, phone: "0825550101", createdById: rep.id, tenantId },
  });
  let number = 820_000_000 + Math.floor(Math.random() * 70_000_000);
  const acceptedAt = new Date(Date.now() - 3 * 86_400_000);
  const quoteReadyToDeliver = async (owner = { tenantId, repId: rep.id, contactId: contact.id as string | null }) => {
    const quote = await basePrisma.quote.create({
      data: {
        number: number++, status: "accepted", tenantId: owner.tenantId, createdById: owner.repId, contactId: owner.contactId,
        signedAt: acceptedAt, signedByName: "Earlier Signature", invoicedAt: acceptedAt, depositPaidAt: acceptedAt, deliveryScheduledFor: new Date(Date.now() + 86_400_000),
      },
    });
    await basePrisma.quoteItem.createMany({
      data: [
        { quoteId: quote.id, tenantId: owner.tenantId, description: `Nomad XL ${SFX}`, qty: 1, unitPriceCents: 24_000_000 },
        { quoteId: quote.id, tenantId: owner.tenantId, description: "Rain enclosure", qty: 2, unitPriceCents: 450_000 },
      ],
    });
    return quote;
  };
  const requestsFor = (quoteId: string) =>
    basePrisma.signatureRequest.findMany({
      where: { subjectType: DELIVERY_NOTE, subjectId: quoteId },
      orderBy: { createdAt: "asc" },
      include: { recipients: true, fields: true },
    });
  const noFacts: HandoverFacts = { deliveredByName: "Sipho Mahlangu", runIds: [], checklist: null };
  const start = (quoteId: string, facts: HandoverFacts = noFacts) => inScope(() => prepareDeliveryNote({ quoteId, tenantId, user: rep, facts }, standInPdf));
  const signInPerson = async (request: Awaited<ReturnType<typeof requestsFor>>[number]) => {
    // The signing route is throttled per link and per caller address, and with
    // no HTTP request every call shares the "unknown" address.
    await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit"`;
    const [signer] = request.recipients;
    const link = await usableCapability("signatureRecipient", signer.id, signer.tokenCiphertext, signer.token);
    const today = new Date().toISOString().slice(0, 10);
    return signRoute(
      new Request(`http://localhost/api/signing/${link}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: customer,
          consent: true,
          consentVersion: "za-ecta-v1",
          inPerson: mintInPersonPass(signer.id, tenantId, { userId: rep.id, name: rep.name }),
          fields: request.fields.filter((f) => f.recipientId === signer.id).map((f) => ({ id: f.id, value: f.kind === "signature" ? SIGNATURE : today })),
        }),
      }),
      { params: Promise.resolve({ token: link ?? "" }) },
    );
  };
  // The delivery itself, as the board (with paperwork of its own) and the stock page (with none) call it.
  type Paperwork = NonNullable<Parameters<typeof deliverQuote>[0]["collectEvidence"]>;
  const deliver = (quoteId: string, collectEvidence?: Paperwork) => inScope(() => deliverQuote({ quoteId, tenantId, user: rep, collectEvidence }));
  const record = (quoteId: string) =>
    basePrisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      select: { status: true, deliveredAt: true, deliveredByName: true, deliveryChecklist: true, deliverySignatureRef: true, deliveryHandoverRunIds: true },
    });
  const CHANGED_MEANWHILE = /changed while this delivery was being completed/;
  const CHANGED_SINCE = /handover changed after the customer signed/;

  // ── 1. The note, where no guided handover is set up ───────────────────────
  console.log("\nMaking the delivery note");
  const quote = await quoteReadyToDeliver();
  const ticks = { "Battery fully charged": true, "Keys handed over": true, "Owner's manual provided": false };
  const first = await start(quote.id, { deliveredByName: "Sipho Mahlangu", runIds: [], checklist: ticks });
  const [request] = await requestsFor(quote.id);
  check(
    "it is ABOUT the quote, and is not the quote's own request",
    request?.id === first.requestId && request.subjectId === quote.id && request.quoteId === null && request.jobCardId === null &&
      request.tenantId === tenantId && request.contactId === contact.id && request.status === "draft",
    JSON.stringify({ quoteId: request?.quoteId, subjectId: request?.subjectId, status: request?.status }),
  );
  check(
    "the customer is its only signer",
    request.recipients.length === 1 && request.recipients[0].name === customer && request.recipients[0].email === contact.email,
    JSON.stringify(request.recipients.map((r) => r.name)),
  );
  const note = text(await inScope(() => renderRequestDocHtml(request)));
  check(
    "the note lists what is being handed over, by whom, and the checklist as ticked",
    note.includes(`DN-${quote.number}`) && note.includes(`Nomad XL ${SFX}`) && note.includes("Rain enclosure") &&
      note.includes("Delivered by: Sipho Mahlangu") && note.includes("Battery fully charged") && note.includes("Received in good order."),
    note.slice(0, 500),
  );
  check("nothing is left as a placeholder, and there are no ruled lines to sign on", !/\{\{[\w.]+\}\}/.test(note) && !/_{10,}/.test(note), note.match(/\{\{[\w.]+\}\}/)?.[0]);
  await basePrisma.quoteItem.updateMany({ where: { quoteId: quote.id, description: "Rain enclosure" }, data: { description: "Changed afterwards" } });
  const later = text(await inScope(() => renderRequestDocHtml(request)));
  check("a change to the quote afterwards does not change the note", later.includes("Rain enclosure") && !later.includes("Changed afterwards"));
  check("the delivery reads: open, waiting for the customer", (await inScope(() => deliveryNoteState(quote.id))).kind === "open");
  check("nothing is signed yet, so there is nothing to complete a delivery against", (await inScope(() => signedDeliveryNote(quote.id, tenantId))) === null);

  // ── 2. The customer signs ─────────────────────────────────────────────────
  console.log("\nThe customer signs");
  const signed = await signInPerson(request);
  check("the signature is accepted — on the driver's pass, with no signing permission involved", signed.status === 200, `HTTP ${signed.status} ${signed.status === 200 ? "" : await signed.text()}`);
  const evidence = await inScope(() => signedDeliveryNote(quote.id, tenantId));
  check(
    "the signed note says who handed over and what was ticked — read from the note, not from a form",
    evidence?.requestId === request.id && evidence.deliveredByName === "Sipho Mahlangu" && evidence.runIds.length === 0 &&
      evidence.checklist?.["Battery fully charged"] === true && evidence.checklist?.["Owner's manual provided"] === false && evidence.signedByName === customer,
    JSON.stringify(evidence),
  );
  const drawn = evidence?.signatureRef ? await inScope(() => readFile(evidence.signatureRef!, tenantId)).catch(() => null) : null;
  check("their drawn signature can be read back, to file with the delivery", Boolean(drawn && drawn.subarray(1, 4).toString() === "PNG"));
  check("another workspace asking gets nothing", (await inScope(() => signedDeliveryNote(quote.id, other.tenantId), other.tenantId)) === null);

  const after = await basePrisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
  check(
    "signing the delivery note delivers nothing, and does not touch the quote's own signature",
    after.deliveredAt === null && after.status === "accepted" && after.signedAt?.getTime() === acceptedAt.getTime() &&
      after.signedByName === "Earlier Signature" && after.deliverySignatureRef === null && after.signedPdfHash === null,
    JSON.stringify({ deliveredAt: after.deliveredAt, status: after.status, signedByName: after.signedByName }),
  );

  const sealedRequest = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
  const sealed = sealedRequest.status === "completed";
  console.log(sealed ? "  (a browser was available: the note was sealed for real)" : "  (no browser here: signed, sealing left to the retry worker)");
  const file = (subject: { subjectId: string; tenantId: string }, documentId: string | null) =>
    basePrisma.$transaction(async (tx) => {
      const row = { subjectType: DELIVERY_NOTE, ...subject };
      await lockSubject(tx, row);
      return completeSubject(tx, row, documentId);
    });
  const loose = (owner = tenantId) =>
    basePrisma.document.create({
      data: { fileName: "sealed.pdf", storedName: `dn-test-${SFX}-${Math.random().toString(16).slice(2)}.pdf`, mimeType: "application/pdf", sizeBytes: 1, contactId: owner === tenantId ? contact.id : null, tenantId: owner, tag: "signed", uploadedById: owner === tenantId ? rep.id : other.rep.id },
    });
  if (sealed) {
    const filed = await basePrisma.document.findFirst({ where: { id: sealedRequest.signedDocId ?? "" } });
    check("the sealed note is filed under the quote, as its delivery note", filed?.quoteId === quote.id && filed.tag === "delivery-note" && filed.tenantId === tenantId && filed.contactId === contact.id, JSON.stringify({ quoteId: filed?.quoteId, tag: filed?.tag }));
    check("the delivery reads: signed", (await inScope(() => deliveryNoteState(quote.id))).kind === "signed");
  } else {
    check("the delivery reads: signed, the sealed copy still to come", (await inScope(() => deliveryNoteState(quote.id))).kind === "finishing");
  }

  // The filing step itself, whichever of the two happened above.
  const document = await loose();
  check("the filing step puts a sealed note under its quote", (await file({ subjectId: quote.id, tenantId }, document.id)) === true);
  const refiled = await basePrisma.document.findUniqueOrThrow({ where: { id: document.id } });
  check("…tagged as the delivery note", refiled.quoteId === quote.id && refiled.tag === "delivery-note");
  const elsewhere = await quoteReadyToDeliver({ tenantId: other.tenantId, repId: other.rep.id, contactId: null });
  const stray = await loose();
  check("a note cannot be filed under another workspace's quote", (await file({ subjectId: elsewhere.id, tenantId }, stray.id)) === false);
  const theirs = await loose(other.tenantId);
  check("nor can another workspace's document be pulled under this one's quote", (await file({ subjectId: quote.id, tenantId }, theirs.id)) === false);
  const untouched = await basePrisma.document.findMany({ where: { id: { in: [stray.id, theirs.id] } }, select: { quoteId: true, tag: true } });
  check("both were left exactly as they were", untouched.every((d) => d.quoteId === null && d.tag === "signed"), JSON.stringify(untouched));
  check("with no sealed document there is nothing to file", (await file({ subjectId: quote.id, tenantId }, null)) === false);

  // ── 3. The handover changes after they signed ─────────────────────────────
  console.log("\nThe handover changes after they signed");
  const second = await start(quote.id, { deliveredByName: "Thabo Nkosi", runIds: [], checklist: ticks });
  const both = await requestsFor(quote.id);
  check("a new note can be made, and the signed one is kept", second.replaced.length === 0 && both.length === 2 && both[0].status === sealedRequest.status && both[1].id === second.requestId, both.map((r) => r.status).join(", "));
  check("the delivery now waits on the NEW note", (await inScope(() => deliveryNoteState(quote.id))).kind === "open");
  check("and the earlier signature no longer completes a delivery", (await inScope(() => signedDeliveryNote(quote.id, tenantId))) === null);
  const withdrawn = await basePrisma.$transaction((tx) => withdrawOpenDeliveryNote(tx, { id: quote.id, tenantId }));
  check("withdrawing the unsigned one leaves the signed one standing", withdrawn.join() === second.requestId && (await inScope(() => signedDeliveryNote(quote.id, tenantId)))?.requestId === request.id);
  check("another workspace cannot withdraw anything here", (await basePrisma.$transaction((tx) => withdrawOpenDeliveryNote(tx, { id: quote.id, tenantId: other.tenantId }))).length === 0);

  // ── 4. Completing the delivery, where no guided handover is set up ────────
  // The paperwork callback runs after the delivery has read the signed note and
  // passed its gates, and before its transaction — which is exactly where a
  // second device can change things. So that is where these change them.
  console.log("\nCompleting the delivery");
  let late = "";
  const overtaken = await refusal(() =>
    deliver(quote.id, async () => {
      late = (await prepareDeliveryNote({ quoteId: quote.id, tenantId, user: rep, facts: { ...noFacts, deliveredByName: "Late Change" } }, standInPdf)).requestId;
      return {};
    }),
  );
  check("a note opened while the delivery is being completed stops it", CHANGED_MEANWHILE.test(overtaken ?? "") && (await record(quote.id)).deliveredAt === null, String(overtaken));
  const lateNote = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: late }, select: { status: true } });
  check("…and that note is still there for the customer to sign", lateNote.status !== "voided", lateNote.status);
  check("nothing was filed for the delivery that did not happen", (await basePrisma.document.count({ where: { quoteId: quote.id, tag: "delivery-signature" } })) === 0);
  await basePrisma.$transaction((tx) => withdrawOpenDeliveryNote(tx, { id: quote.id, tenantId }));

  await deliver(quote.id, async () => ({ deliveredByName: "Somebody Else", deliveryChecklist: { "Battery fully charged": false } }));
  const row = await record(quote.id);
  check(
    "the delivery is recorded against the signed note — who handed over and the ticks are the note's, not the caller's",
    Boolean(row.deliveredAt) && row.status === "accepted" && row.deliveredByName === "Sipho Mahlangu" && row.deliveryHandoverRunIds.length === 0 &&
      (row.deliveryChecklist as Record<string, boolean> | null)?.["Battery fully charged"] === true,
    JSON.stringify(row),
  );
  const filedSignature = await basePrisma.document.findMany({ where: { quoteId: quote.id, tag: "delivery-signature" } });
  check(
    "the signature they drew is filed with the delivery, as a copy of its own in this workspace",
    filedSignature.length === 1 && filedSignature[0].storedName === row.deliverySignatureRef && filedSignature[0].tenantId === tenantId &&
      row.deliverySignatureRef !== evidence?.signatureRef && Boolean((await inScope(() => readFile(row.deliverySignatureRef!, tenantId))).length),
    JSON.stringify({ filed: filedSignature.length, same: row.deliverySignatureRef === evidence?.signatureRef }),
  );
  check("the signed note is untouched by the delivery", (await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } })).status === sealedRequest.status);
  check("delivering it twice is refused", /already marked as delivered/.test((await refusal(() => deliver(quote.id))) ?? ""));

  const walkIn = await quoteReadyToDeliver();
  const left = await start(walkIn.id);
  await deliver(walkIn.id, async () => ({ deliveredByName: "Thabo Nkosi", deliveryChecklist: { "Keys handed over": true } }));
  const unsignedRow = await record(walkIn.id);
  check(
    "with no guided handover a delivery can still be confirmed without a signature — on the caller's word, with none filed",
    Boolean(unsignedRow.deliveredAt) && unsignedRow.deliveredByName === "Thabo Nkosi" && unsignedRow.deliverySignatureRef === null &&
      (await basePrisma.document.count({ where: { quoteId: walkIn.id, tag: "delivery-signature" } })) === 0,
    JSON.stringify(unsignedRow),
  );
  const leftNote = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: left.requestId }, include: { recipients: true, events: { where: { type: "voided" } } } });
  check(
    "the note left open on the signing screen is withdrawn with it, its link dies, and the evidence says why",
    leftNote.status === "voided" && leftNote.recipients.every((r) => r.tokenRevokedAt !== null) && leftNote.events.length === 1 &&
      (leftNote.events[0].metadata as { via?: string } | null)?.via === "delivery",
    `${leftNote.status}, ${leftNote.events.length} event(s)`,
  );

  const kerb = await quoteReadyToDeliver();
  await start(kerb.id);
  const [kerbNote] = await requestsFor(kerb.id);
  const justSigned = await refusal(() =>
    deliver(kerb.id, async () => {
      await signInPerson(kerbNote);
      return { deliveredByName: "Thabo Nkosi" };
    }),
  );
  check(
    "a signature that lands while a delivery is being confirmed WITHOUT one stops it — it is not recorded as unsigned",
    CHANGED_MEANWHILE.test(justSigned ?? "") && (await record(kerb.id)).deliveredAt === null,
    String(justSigned),
  );
  await deliver(kerb.id); // as the stock page does: no paperwork of its own
  const kerbRow = await record(kerb.id);
  check(
    "confirmed again it carries their signature — from the stock page's button as much as the board's",
    Boolean(kerbRow.deliveredAt) && kerbRow.deliveredByName === "Sipho Mahlangu" && Boolean(kerbRow.deliverySignatureRef),
    JSON.stringify(kerbRow),
  );

  // ── 5. A guided handover: the reviewed runs, and their photos ─────────────
  console.log("\nA guided handover");
  const guided = await quoteReadyToDeliver();
  const template = await basePrisma.checklistTemplate.create({ data: { tenantId, host: "quote.delivery", name: `Customer handover ${SFX}`, active: true } });
  await basePrisma.checklistTemplateRevision.create({ data: { tenantId, templateId: template.id, version: 1, items: [] } });
  const photoRef = await saveFile(Buffer.from(PNG_BASE64, "base64"), "handover.png", "image/png", tenantId);
  const runFor = async (hostId: string, done: boolean) => {
    const id = `dn_run_${SFX}_${Math.random().toString(16).slice(2, 8)}`;
    await basePrisma.checklistRun.create({ data: { id, tenantId, templateId: template.id, templateVersion: 1, hostType: "quote.delivery", hostId, completedAt: done ? new Date() : null } });
    await basePrisma.checklistEntry.create({
      data: { id: `${id}_e`, tenantId, runId: id, itemIdSnapshot: "walkaround", labelSnapshot: `Walk-around with the customer ${SFX}`, captureSnapshot: "photo", status: "done" },
    });
    await basePrisma.checklistPhoto.create({ data: { id: `${id}_p`, tenantId, entryId: `${id}_e`, url: photoRef, capturedAt: new Date() } });
    return id;
  };
  const reviewed = await runFor(guided.id, true);
  const unfinished = await runFor(guided.id, false);
  const someoneElses = await runFor(quote.id, true);
  const verify = (claimed: string[]) => inScope(() => reviewedHandoverRuns(tenantId, guided.id, claimed));
  check("the reviewed run is accepted", JSON.stringify(await verify([reviewed])) === JSON.stringify({ guided: true, runIds: [reviewed] }));
  check("no runs named is refused", /review it again/.test((await refusal(() => verify([]))) ?? ""));
  check("an unfinished run is refused", /changed since it was reviewed/.test((await refusal(() => verify([unfinished]))) ?? ""));
  check("another quote's run is refused", /changed since it was reviewed/.test((await refusal(() => verify([someoneElses]))) ?? ""));
  check("a made-up id is refused", /changed since it was reviewed/.test((await refusal(() => verify([`nope_${SFX}`]))) ?? ""));
  // A list that covers every checklist is not enough: nothing else may ride in with it.
  check("a genuine run does not carry another quote's in with it", /changed since it was reviewed/.test((await refusal(() => verify([reviewed, someoneElses]))) ?? ""));
  const redone = await runFor(guided.id, true);
  check("two runs for one checklist are refused — the note would show it twice", /changed since it was reviewed/.test((await refusal(() => verify([reviewed, redone]))) ?? ""));
  const extra = await basePrisma.checklistTemplate.create({ data: { tenantId, host: "quote.delivery", name: `Paperwork ${SFX}`, active: true, sortOrder: 5 } });
  check("a second checklist that is not finished stops the customer being asked to sign", /Finish “Paperwork/.test((await refusal(() => verify([reviewed]))) ?? ""));
  await basePrisma.checklistTemplate.update({ where: { id: extra.id }, data: { active: false } });
  check("in a workspace with no guided handover, no runs apply", JSON.stringify(await inScope(() => reviewedHandoverRuns(other.tenantId, elsewhere.id, [reviewed]), other.tenantId)) === JSON.stringify({ guided: false, runIds: [] }));
  check("a note cannot be made for a run that is not this quote's", /changed since it was reviewed/.test((await refusal(() => start(guided.id, { ...noFacts, runIds: [someoneElses] }))) ?? ""));

  await start(guided.id, { ...noFacts, runIds: [reviewed] });
  const [guidedRequest] = await requestsFor(guided.id);
  const frozen = JSON.stringify(guidedRequest.contextJson);
  check("the reviewed run is frozen into the note", frozen.includes(`Walk-around with the customer ${SFX}`) && frozen.includes(reviewed));
  check("its photo is kept as a reference, not as megabytes in the request", frozen.includes(photoRef) && !frozen.includes("data:image"), `${frozen.length} characters`);
  const guidedHtml = await inScope(() => renderRequestDocHtml(guidedRequest));
  check("the note the customer reads shows the checklist and the photo itself", text(guidedHtml).includes(`Walk-around with the customer ${SFX}`) && guidedHtml.includes(`data:image/png;base64,${PNG_BASE64}`));

  // ── 6. Completing a guided delivery ───────────────────────────────────────
  console.log("\nCompleting a guided delivery");
  const unsignedGuided = await refusal(() => deliver(guided.id));
  check("a guided handover is not delivered while its note is unsigned", /uses a guided handover/.test(unsignedGuided ?? "") && (await record(guided.id)).deliveredAt === null, String(unsignedGuided));
  check("…and the refusal leaves the open note alone", (await requestsFor(guided.id))[0].status !== "voided");
  const guidedSigned = await signInPerson(guidedRequest);
  const guidedEvidence = await inScope(() => signedDeliveryNote(guided.id, tenantId));
  check("signed, the note names exactly the run that was reviewed", guidedSigned.status === 200 && guidedEvidence?.runIds.join() === reviewed && guidedEvidence.checklist === null, JSON.stringify(guidedEvidence?.runIds));

  await basePrisma.checklistTemplate.update({ where: { id: extra.id }, data: { active: true } });
  const widened = await refusal(() => deliver(guided.id));
  check("a checklist switched on after they signed means signing again, not delivering", CHANGED_SINCE.test(widened ?? "") && (await record(guided.id)).deliveredAt === null, String(widened));
  await basePrisma.checklistTemplate.update({ where: { id: extra.id }, data: { active: false } });

  await deliver(guided.id, async () => ({ deliveredByName: "Somebody Else" }));
  const guidedRow = await record(guided.id);
  check(
    "delivered, it is recorded against that run, that driver and that signature",
    Boolean(guidedRow.deliveredAt) && guidedRow.deliveryHandoverRunIds.join() === reviewed && guidedRow.deliveredByName === "Sipho Mahlangu" && Boolean(guidedRow.deliverySignatureRef),
    JSON.stringify(guidedRow),
  );

  const removed = await quoteReadyToDeliver();
  const removedRun = await runFor(removed.id, true);
  await start(removed.id, { ...noFacts, runIds: [removedRun] });
  await signInPerson((await requestsFor(removed.id))[0]);
  await basePrisma.checklistRun.delete({ where: { id: removedRun } });
  const gone = await refusal(() => deliver(removed.id));
  check("a run removed after the note froze it stops the delivery too", CHANGED_SINCE.test(gone ?? "") && (await record(removed.id)).deliveredAt === null, String(gone));

  // ── 7. When it cannot be signed for ───────────────────────────────────────
  console.log("\nWhen it cannot be signed for");
  const unscheduled = await quoteReadyToDeliver();
  await basePrisma.quote.update({ where: { id: unscheduled.id }, data: { deliveryScheduledFor: null } });
  check("not before the delivery is scheduled", /Schedule the delivery/.test((await refusal(() => start(unscheduled.id))) ?? ""));
  check("not once it has been delivered", /already marked as delivered/.test((await refusal(() => start(quote.id))) ?? ""));
  check("not for another workspace's quote", /no longer available/.test((await refusal(() => start(elsewhere.id))) ?? ""));
  check("and none of those made anything", (await requestsFor(unscheduled.id)).length + (await requestsFor(elsewhere.id)).length === 0 && (await requestsFor(quote.id)).length === 3);

  __setTenantEnforcingForTests(null);
  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
