/**
 * A TEST DRIVE'S INDEMNITY, SIGNED ON A SCREEN — what the database actually does.
 *
 * The unit tests pin the wording and the order of the steps. These are the parts
 * that only exist against a real database, with tenant enforcement on and the
 * real signing route:
 *
 *   - the indemnity is made for the booking, in the booking's workspace, with
 *     the driver as its only signer;
 *   - what the driver is shown is FROZEN: renaming the customer or swapping the
 *     vehicle afterwards does not change a document already on the screen;
 *   - starting again replaces the one that was open, kills its link, and never
 *     touches one that has a signature on it;
 *   - a signature submitted through the real route, witnessed by a member of
 *     staff, is accepted with no signing permission involved;
 *   - completing marks the booking — only its own, only a live one, only in the
 *     request's own workspace.
 *
 * The unsigned and sealed PDFs are rendered by a browser process. Making the
 * indemnity takes a stand-in for the first. The second is part of completion, so
 * where no browser is available the request is left signed-but-unsealed (as it
 * would be in production until the retry worker gets to it) and the step that
 * marks the booking is run directly; where one is, completion runs for real and
 * is checked end to end. The script says which happened.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Signing
 * evidence is append-only, so the rows stay behind in workspaces of their own.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { ActionRefusal } from "../src/lib/actionFailure";
import { indemnityState, prepareIndemnity, recordIndemnityWithdrawn, withdrawOpenIndemnity } from "../src/lib/testDriveIndemnity";
import { completeSubject, lockSubject } from "../src/lib/signing/subjectCompletion";
import { TEST_DRIVE_INDEMNITY } from "../src/lib/signing/subject";
import { renderRequestDocHtml } from "../src/lib/signing/render";
import { usableCapability } from "../src/lib/signing/tokenVault";
import { mintInPersonPass } from "../src/lib/signing/inPerson";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { newOverlayField, newRecipient, uid } from "../src/lib/doceditor/factory";
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

// A 1×1 PNG: the smallest thing the route accepts as a drawn signature.
const SIGNATURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const standInPdf = async () => Buffer.from("%PDF-1.4\n% stand-in for the unsigned copy, which a browser process renders\n");

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
  // The signing route is throttled per link and per caller address, and with no
  // HTTP request every call shares the "unknown" address.
  await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit"`;

  const workspace = async (label: string) => {
    const tenantId = `td_${label}_${SFX}`;
    await basePrisma.tenant.create({ data: { id: tenantId, name: `Test Drive ${label} ${SFX}`, slug: tenantId, active: true, modules: "automotive" } });
    const user = await basePrisma.user.create({
      data: { id: `td_rep_${label}_${SFX}`, name: `Rep ${label} ${SFX}`, email: `td-rep-${label}-${SFX}@example.test`, passwordHash: "x", role: "sales", tenantId },
    });
    await basePrisma.tenantMember.create({ data: { tenantId, userId: user.id } });
    return { tenantId, rep: { id: user.id, name: user.name, email: user.email } };
  };
  const { tenantId, rep } = await workspace("a");
  const other = await workspace("b");
  const inScope = <T>(work: () => Promise<T>, tenant = tenantId) => runInTenantScope({ tenantId: tenant, system: false }, work);

  const contact = await basePrisma.contact.create({
    data: { firstName: "Naledi", lastName: `Dlamini${SFX}`, email: `naledi-${SFX}@example.test`, phone: "0825550101", createdById: rep.id, tenantId },
  });
  const demo = await basePrisma.demoVehicle.create({ data: { tenantId, name: `Nomad XL demo ${SFX}`, color: "Forest green", regNumber: "CA 123-456", status: "active" } });
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const book = (extra: object = {}) =>
    basePrisma.testDriveBooking.create({
      data: {
        tenantId, reference: `TD-${uid().slice(0, 10).toUpperCase()}`, status: "booked", contactId: contact.id, branch: "Showroom",
        salespersonId: rep.id, scheduledStart: soon(24), expectedReturnAt: soon(25), driverLicenceNumber: "0412 3456 7890", ...extra,
      },
    });
  const booking = await book({ demoVehicleId: demo.id });
  const requestsFor = (bookingId: string) =>
    basePrisma.signatureRequest.findMany({
      where: { subjectType: TEST_DRIVE_INDEMNITY, subjectId: bookingId },
      orderBy: { createdAt: "asc" },
      include: { recipients: true, fields: true },
    });
  const start = (bookingId: string) => inScope(() => prepareIndemnity(bookingId, rep, standInPdf));

  // ── 1. Making it ──────────────────────────────────────────────────────────
  console.log("\nMaking the indemnity");
  const first = await start(booking.id);
  let [request] = await requestsFor(booking.id);
  check(
    "it is made for the booking, in the booking's workspace, about nothing else",
    request?.id === first.requestId && request.tenantId === tenantId && request.contactId === contact.id &&
      request.quoteId === null && request.jobCardId === null && request.documentId === null && request.status === "draft" && Boolean(request.unsignedPdfRef),
    JSON.stringify({ tenantId: request?.tenantId, status: request?.status, quoteId: request?.quoteId, documentId: request?.documentId }),
  );
  const [driver] = request.recipients;
  check(
    "the driver is its only signer, with the customer's own contact details",
    request.recipients.length === 1 && driver.role === "signer" && driver.name === `Naledi Dlamini${SFX}` &&
      driver.email === contact.email && Boolean(driver.phone?.endsWith("825550101")) && driver.tenantId === tenantId,
    JSON.stringify(request.recipients.map((r) => ({ name: r.name, role: r.role, phone: r.phone }))),
  );
  const kinds = request.fields.filter((f) => f.recipientId === driver.id).map((f) => f.kind).sort();
  check("they have a signature and a date to fill in", kinds.join(",") === "date,signature", kinds.join(","));
  const opened = await inScope(() => indemnityState(booking.id));
  check("the booking reads: open, waiting for that signer", opened.kind === "open" && opened.recipientId === driver.id, JSON.stringify(opened));
  const elsewhere = await inScope(() => indemnityState(booking.id), other.tenantId);
  check("another workspace asking about the same booking sees nothing", elsewhere.kind === "none", JSON.stringify(elsewhere));

  // ── 2. What the driver is shown ───────────────────────────────────────────
  console.log("\nWhat the driver is shown");
  const shown = await inScope(() => renderRequestDocHtml(request));
  check(
    "the document names the driver, their licence and the vehicle booked",
    shown.includes(`Naledi Dlamini${SFX}`) && shown.includes("Driver&#39;s licence: 0412 3456 7890") && shown.includes(`Nomad XL demo ${SFX}`) && shown.includes("Reg: CA 123-456"),
    shown.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400),
  );
  check("nothing is left as a placeholder", !/\{\{[\w.]+\}\}/.test(shown), shown.match(/\{\{[\w.]+\}\}/)?.[0]);
  check("and it is the screen version: no lines to write on", !/_{10,}/.test(shown) && !shown.includes("TO BE COMPLETED BY THE DRIVER"));
  // The customer's record and the demo vehicle both change while the document is open.
  await basePrisma.contact.update({ where: { id: contact.id }, data: { firstName: "Renamed" } });
  await basePrisma.demoVehicle.update({ where: { id: demo.id }, data: { regNumber: "CA 999-999" } });
  const later = await inScope(() => renderRequestDocHtml(request));
  check(
    "a change to the customer or the vehicle does not change a document already made",
    later.includes(`Naledi Dlamini${SFX}`) && later.includes("Reg: CA 123-456") && !later.includes("Renamed") && !later.includes("CA 999-999"),
  );

  // ── 3. Starting again ─────────────────────────────────────────────────────
  console.log("\nStarting again");
  const second = await start(booking.id);
  const [replaced, current] = await requestsFor(booking.id);
  check("the one that was open is withdrawn", second.replaced.join() === first.requestId && replaced.status === "voided" && current.id === second.requestId, `${replaced.status} / ${second.replaced.join()}`);
  check("its link is dead", replaced.recipients.every((r) => r.tokenRevokedAt !== null));
  const withdrawnEvent = await basePrisma.signatureEvent.findFirst({ where: { requestId: replaced.id, type: "voided" } });
  check("the evidence says who withdrew it and why", Boolean(withdrawnEvent?.actor.includes(rep.name)) && (withdrawnEvent?.metadata as { via?: string })?.via === "test_drive", JSON.stringify(withdrawnEvent?.metadata ?? null));
  const fresh = await inScope(() => renderRequestDocHtml(current));
  check("the new one carries the details as they are now", fresh.includes(`Renamed Dlamini${SFX}`) && fresh.includes("Reg: CA 999-999"));
  request = current;
  const signer = request.recipients[0];

  // ── 4. Signing on the device ──────────────────────────────────────────────
  console.log("\nSigning on the device");
  const link = await usableCapability("signatureRecipient", signer.id, signer.tokenCiphertext, signer.token);
  const today = new Date().toISOString().slice(0, 10);
  const submission = {
    name: `Renamed Dlamini${SFX}`,
    consent: true,
    consentVersion: "za-ecta-v1",
    inPerson: mintInPersonPass(signer.id, tenantId, { userId: rep.id, name: rep.name }),
    fields: request.fields.filter((f) => f.recipientId === signer.id).map((f) => ({ id: f.id, value: f.kind === "signature" ? SIGNATURE : today })),
  };
  const post = (body: unknown) =>
    signRoute(
      new Request(`http://localhost/api/signing/${link}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ token: link ?? "" }) },
    );
  const unwitnessed = await post({ ...submission, inPerson: mintInPersonPass(signer.id, other.tenantId, { userId: other.rep.id, name: other.rep.name }) });
  check("a pass from another workspace's member of staff is refused", unwitnessed.status === 403, `HTTP ${unwitnessed.status}`);
  const signed = await post(submission);
  check("the driver's signature is accepted — by a salesperson, with no signing permission involved", signed.status === 200, `HTTP ${signed.status} ${signed.status === 200 ? "" : await signed.text()}`);
  const signedRow = await basePrisma.signatureRecipient.findUniqueOrThrow({ where: { id: signer.id } });
  check("it is recorded as signed in person, in front of that member of staff", signedRow.status === "signed" && signedRow.identityMethod === "in_person", `${signedRow.status} / ${signedRow.identityMethod}`);

  // The route seals and files the document straight after the signature. That
  // needs a browser process; without one the signature stands and sealing waits
  // for the retry worker.
  const afterSigning = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id } });
  const sealed = afterSigning.status === "completed";
  console.log(sealed ? "  (a browser was available: the document was sealed for real)" : "  (no browser here: signed, sealing left to the retry worker)");

  const again = await refusal(() => start(booking.id));
  check("once it has a signature it cannot be started again", Boolean(again && /already been signed/.test(again)), String(again));
  const kept = await basePrisma.$transaction((tx) => withdrawOpenIndemnity(tx, { id: booking.id, tenantId }));
  const stillThere = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: request.id }, select: { status: true } });
  check("and calling the test drive off does not withdraw a signed one", kept.length === 0 && stillThere.status === afterSigning.status, `${kept.length} withdrawn, now ${stillThere.status}`);

  // ── 5. Marking the booking ────────────────────────────────────────────────
  console.log("\nMarking the booking");
  const subject = { subjectType: TEST_DRIVE_INDEMNITY, subjectId: booking.id, tenantId };
  const mark = (row: typeof subject) =>
    basePrisma.$transaction(async (tx) => {
      await lockSubject(tx, row);
      // No sealed document to file: marking a booking does not need one.
      return completeSubject(tx, row, null);
    });
  const status = async (id: string) => (await basePrisma.testDriveBooking.findUniqueOrThrow({ where: { id }, select: { indemnityStatus: true } })).indemnityStatus;
  if (sealed) {
    check("completing the request marked the booking Signed", (await status(booking.id)) === "signed", await status(booking.id));
    const filed = await basePrisma.document.findFirst({ where: { id: afterSigning.signedDocId ?? "", tenantId } });
    check("the sealed copy is filed under the customer", filed?.contactId === contact.id && filed.tag === "signed", JSON.stringify({ contactId: filed?.contactId, tag: filed?.tag }));
    const done = await inScope(() => indemnityState(booking.id));
    check("the booking reads: signed, by the name they signed with", done.kind === "signed" && done.signedByName === `Renamed Dlamini${SFX}`, JSON.stringify(done));
  } else {
    const waiting = await inScope(() => indemnityState(booking.id));
    check("the booking reads: signed, being finished — not 'nothing started'", waiting.kind === "finishing" && waiting.signedByName === `Renamed Dlamini${SFX}`, JSON.stringify(waiting));
    check("until it is sealed the booking still says pending", (await status(booking.id)) === "pending", await status(booking.id));
    check("the completion step marks it Signed", (await mark(subject)) === true && (await status(booking.id)) === "signed", await status(booking.id));
  }
  check("running the step again changes nothing", (await mark(subject)) === false && (await status(booking.id)) === "signed");

  const unsigned = await book();
  check("a request in ANOTHER workspace naming this booking cannot mark it", (await mark({ ...subject, subjectId: unsigned.id, tenantId: other.tenantId })) === false && (await status(unsigned.id)) === "pending", await status(unsigned.id));
  check("nor can a request about something else", (await mark({ ...subject, subjectId: unsigned.id, subjectType: "something_else" })) === false && (await status(unsigned.id)) === "pending");
  await basePrisma.testDriveBooking.update({ where: { id: unsigned.id }, data: { deletedAt: new Date() } });
  check("a trashed booking is left alone", (await mark({ ...subject, subjectId: unsigned.id })) === false && (await status(unsigned.id)) === "pending");
  await basePrisma.testDriveBooking.update({ where: { id: unsigned.id }, data: { deletedAt: null } });

  // ── 6. Calling the test drive off ─────────────────────────────────────────
  console.log("\nCalling the test drive off");
  const pending = await start(unsigned.id);
  const withdrawn = await basePrisma.$transaction((tx) => withdrawOpenIndemnity(tx, { id: unsigned.id, tenantId }));
  await inScope(() => recordIndemnityWithdrawn(withdrawn, rep.name, "Test drive cancelled"));
  const gone = await basePrisma.signatureRequest.findUniqueOrThrow({ where: { id: pending.requestId }, include: { recipients: true, events: { where: { type: "voided" } } } });
  check(
    "an indemnity that was open and unsigned is withdrawn with it, and its link dies",
    withdrawn.join() === pending.requestId && gone.status === "voided" && gone.recipients.every((r) => r.tokenRevokedAt !== null) && gone.events.length === 1,
    `${gone.status}, ${gone.events.length} event(s)`,
  );
  check("the booking reads: nothing started", (await inScope(() => indemnityState(unsigned.id))).kind === "none");
  check("somebody else's workspace cannot withdraw it", (await basePrisma.$transaction((tx) => withdrawOpenIndemnity(tx, { id: booking.id, tenantId: other.tenantId }))).length === 0);
  await basePrisma.testDriveBooking.update({ where: { id: unsigned.id }, data: { status: "cancelled" } });
  const tooLate = await refusal(() => start(unsigned.id));
  check("and one cannot be started for a test drive that is not happening", Boolean(tooLate && /no longer upcoming/.test(tooLate)), String(tooLate));

  // ── 7. Signed, and still being sealed ─────────────────────────────────────
  // The state between the driver's signature and the sealed document — seconds
  // normally, longer if sealing has to be retried. Made directly, so it is
  // checked here whether or not this machine could seal the one above.
  console.log("\nSigned, and still being sealed");
  const midway = await book();
  const half = await start(midway.id);
  await basePrisma.signatureRecipient.updateMany({ where: { requestId: half.requestId }, data: { status: "signed", signedAt: new Date(), signedName: "Half Way" } });
  const finishing = await inScope(() => indemnityState(midway.id));
  check("the booking reads: signed, being finished — not 'nothing started'", finishing.kind === "finishing" && finishing.signedByName === "Half Way", JSON.stringify(finishing));
  check("the booking itself still says pending until the document is sealed", (await status(midway.id)) === "pending");
  const notAgain = await refusal(() => start(midway.id));
  check("it cannot be started again over a signature", Boolean(notAgain && /already been signed/.test(notAgain)), String(notAgain));
  const untouched = await basePrisma.$transaction((tx) => withdrawOpenIndemnity(tx, { id: midway.id, tenantId }));
  const halfNow = await requestsFor(midway.id);
  check(
    "and neither that nor calling the test drive off withdrew it",
    untouched.length === 0 && halfNow.length === 1 && halfNow[0].status !== "voided" && halfNow[0].recipients.every((r) => r.tokenRevokedAt === null),
    `${untouched.length} withdrawn, ${halfNow.length} request(s), ${halfNow[0]?.status}`,
  );

  // ── 8. The workspace's own layout ─────────────────────────────────────────
  console.log("\nA layout the workspace published");
  const third = await book();
  // Making the first indemnity seeded this workspace's layouts (unpublished).
  const layout = await basePrisma.docBuilderTemplate.findFirst({ where: { tenantId, key: "indemnity", deletedAt: null }, orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }] });
  if (!layout) throw new Error("the workspace has no indemnity layout — has seeding changed?");
  const publish = async (doc: object) => {
    const version = ((await basePrisma.docBuilderVersion.aggregate({ where: { templateId: layout.id }, _max: { version: true } }))._max.version ?? 0) + 1;
    await basePrisma.docBuilderVersion.create({ data: { tenantId, templateId: layout.id, version, data: doc } });
    await basePrisma.docBuilderTemplate.update({ where: { id: layout.id }, data: { data: doc, status: "published", publishedVersion: version } });
  };
  const own = standardTemplateFor("indemnity");
  await publish(own);
  const drawn = await start(third.id);
  const [ownRequest] = await requestsFor(third.id);
  const ownHtml = await inScope(() => renderRequestDocHtml(ownRequest));
  check("once published, the workspace's own indemnity is what gets signed — as drawn", ownRequest.id === drawn.requestId && ownHtml.includes("TO BE COMPLETED BY THE DRIVER"));

  // …and the same layout with a signature block for the company as well.
  const company = newRecipient({ party: "denago", name: "Our team", email: "", role: "signer" });
  const cosigned = standardTemplateFor("indemnity");
  cosigned.recipients = [company];
  cosigned.pages[0].overlayFields.push(
    newOverlayField("signature", { id: uid(), recipientId: company.id, required: true, label: "For the company", anchor: { mode: "page", blockId: null, x: 430, y: 900 }, width: 200, height: 50 }),
  );
  await publish(cosigned);
  const before = (await requestsFor(third.id)).length;
  const twoSigners = await refusal(() => start(third.id));
  check("a layout that also asks the company to sign is refused, with the reason", Boolean(twoSigners && /also asks for a signature/.test(twoSigners)), String(twoSigners));
  const after = await requestsFor(third.id);
  check("and nothing was made or withdrawn by the refused attempt", after.length === before && after[0].status !== "voided", `${after.length} request(s), first ${after[0].status}`);

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
