/**
 * The test-drive indemnity, signed on a screen.
 *
 * It was a printed form and a dropdown someone remembered to change. It is now a
 * signature request ABOUT the booking — the first request that is about neither
 * a quote nor a job card — so these pin the two things that being "about"
 * something else has to get right, and the rules that keep the booking honest:
 *
 *   - the document renders from values FROZEN with the request, because nothing
 *     locks a booking or its customer while the driver is reading;
 *   - completing it marks the booking in the SAME transaction, in the booking's
 *     own workspace, and a form rendered earlier cannot un-mark it;
 *   - whoever may manage the test drive may run it — not whoever holds the
 *     Signatures permission.
 *
 * What only a database can show is in scripts/test-test-drive-indemnity.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLeadContext, buildTestDriveContext, type TestDriveForDoc } from "../src/lib/docbuilder/leadWarrantyContext";
import { INDEMNITY_SIGN_Y, indemnityTemplateForScreen, standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { parseSubjectContext, TEST_DRIVE_INDEMNITY } from "../src/lib/signing/subject";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Line endings normalised: a Windows checkout has CRLF, CI has LF.
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
/** Without comments, so a rule described in prose is not mistaken for one that is enforced. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const fnBody = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone — was it renamed?`);
  return source.slice(start, source.indexOf("\n}", start));
};

const drive: TestDriveForDoc = {
  driverLicenceNumber: "0412 3456 7890",
  contact: { firstName: "Naledi", lastName: "Dlamini", phone: "082 555 0101", email: "naledi@example.test", city: "Cape Town" },
  vehicle: { name: "Nomad XL (demo)", color: "Forest green", regNumber: "CA 123-456" },
  productName: "Nomad XL",
  lead: { title: "Nomad for the farm", status: "open", source: "walk-in" },
};
const NOW = new Date(Date.UTC(2026, 9, 10, 9, 0, 0));

// ── What the document says ──────────────────────────────────────────────────

test("the indemnity names the booking's driver and the demo vehicle actually booked", () => {
  const { tokens } = buildTestDriveContext(drive, NOW);
  assert.equal(tokens["customer.name"], "Naledi Dlamini");
  assert.equal(tokens.vehicle, "Nomad XL (demo)", "the vehicle going out, not the model first asked about");
  assert.equal(tokens["vehicle.lines"], "Colour: Forest green\nReg: CA 123-456");
  assert.equal(tokens["customer.lines"], "082 555 0101\nnaledi@example.test\nDriver's licence: 0412 3456 7890");
  assert.match(tokens["date.today"], /2026/);
});

test("it uses the same tokens as the printed (lead) indemnity, so one layout serves both", () => {
  const lead = buildLeadContext({ title: "t", name: "n", phone: null, email: null, color: null, status: "open", source: "web", product: null, contact: null }, NOW);
  const booking = buildTestDriveContext(drive, NOW);
  for (const token of Object.keys(lead.tokens)) {
    assert.ok(token in booking.tokens, `a layout using {{${token}}} would print it literally on the signed indemnity`);
  }
});

test("before a demo vehicle is assigned, or a licence captured, nothing is invented", () => {
  const early = buildTestDriveContext({ ...drive, vehicle: null, driverLicenceNumber: null }, NOW).tokens;
  assert.equal(early.vehicle, "Nomad XL", "the model asked for stands in until a demo vehicle is assigned");
  assert.equal(early["vehicle.lines"], "");
  assert.equal(early["customer.lines"], "082 555 0101\nnaledi@example.test", "no licence line without a licence");
});

test("the standard indemnity for a screen drops only what needs a pen", () => {
  const printed = JSON.stringify(standardTemplateFor("indemnity"));
  const screen = JSON.stringify(indemnityTemplateForScreen());
  assert.match(printed, /TO BE COMPLETED BY THE DRIVER/, "the printed form still has its fill-in lines");
  assert.match(printed, /_{20,}/);
  assert.doesNotMatch(screen, /TO BE COMPLETED BY THE DRIVER/, "nobody can write a licence number on a screen");
  assert.doesNotMatch(screen, /_{10,}/, "and a ruled line nobody can sign on would sit above the real signature box");
  // The undertaking itself is word for word the same.
  const waiver = /I, the undersigned, acknowledge[^"]+permitted by law\./;
  assert.equal(screen.match(waiver)?.[0], printed.match(waiver)?.[0]);
  assert.ok(screen.match(waiver), "the waiver is there at all");
  for (const token of ["{{customer.name}}", "{{customer.lines}}", "{{vehicle}}", "{{vehicle.lines}}", "{{date.today}}"]) {
    assert.ok(screen.includes(token), `${token} is on the screen version`);
  }
});

test("on the screen version the driver signs under the waiver, on the same page", () => {
  const doc = indemnityTemplateForScreen();
  assert.equal(doc.pages.length, 1, "one sheet — not a second one holding a single box");
  const [driver] = doc.recipients;
  assert.ok(doc.recipients.length === 1 && driver.party === "customer" && driver.role === "signer", "the driver, as a PARTY: the booking says who that is");
  const fields = doc.pages[0].overlayFields;
  assert.deepEqual(fields.map((f) => f.kind).sort(), ["date", "signature"]);
  assert.ok(fields.every((f) => f.recipientId === driver.id && f.required && f.anchor.mode === "page"), "both are the driver's, and both are required");

  // The box is at a fixed place and the text above it flows, so room is kept for
  // it (see INDEMNITY_SIGN_Y). The measured range the text ends in is 344–450px.
  const blocks = doc.pages[0].rows.flatMap((row) => row.columns.flatMap((column) => column.blocks));
  const order = blocks.map((b) => b.type);
  const room = blocks.find((b) => b.type === "spacer");
  assert.ok(room && room.type === "spacer", "room is left for the signature");
  assert.equal(order.indexOf("spacer"), order.lastIndexOf("infoCard") + 1, "straight after the waiver");
  assert.equal(order.indexOf("footer"), order.indexOf("spacer") + 1, "and before the footer");
  const top = Math.min(...doc.pages[0].floatingBlocks.map((f) => f.y));
  const bottom = Math.max(...fields.map((f) => f.anchor.y + f.height));
  const [textEndsEarliest, textEndsLatest] = [344, 450];
  const gap = 14; // what a row leaves beneath the waiver's card before the room starts
  assert.ok(top >= textEndsLatest + gap, `at its tallest the text ends at ${textEndsLatest}px; the label starts at ${top}px`);
  assert.ok(bottom <= textEndsEarliest + gap + room.height, `at its shortest the room ends at ${textEndsEarliest + gap + room.height}px; the box ends at ${bottom}px`);
  assert.equal(fields.find((f) => f.kind === "signature")?.anchor.y, INDEMNITY_SIGN_Y);
});

// ── Frozen with the request ─────────────────────────────────────────────────

test("a stored context of the wrong shape reads as none, and never throws a render", () => {
  assert.equal(parseSubjectContext(null), null);
  assert.equal(parseSubjectContext("tokens"), null);
  assert.equal(parseSubjectContext([]), null);
  assert.equal(parseSubjectContext({ items: [] }), null, "no tokens, no context");
  assert.equal(parseSubjectContext({ tokens: ["a"] }), null);
  assert.deepEqual(parseSubjectContext({ tokens: { a: "1" }, items: "x", vars: [] }), { tokens: { a: "1" }, items: [], vars: {} });
  const whole = buildTestDriveContext(drive, NOW);
  assert.deepEqual(parseSubjectContext(JSON.parse(JSON.stringify(whole))), whole, "what is stored comes back as it went in");
});

test("every render of a request reads its frozen context — the signer's screen, the preview and the sealed PDF", () => {
  const render = code("src/lib/signing/render.ts");
  for (const fn of ["renderRequestDocHtml", "renderRequestSigningSheets"]) {
    const body = fnBody(render, fn);
    assert.match(body, /"contextJson"/, `${fn} must REQUIRE the column, so no caller can render without it`);
    assert.match(body, /bindCtx\(req\.quoteId, req\.jobCardId, frozen, \{ liveVehicle: false, context: req\.contextJson \}\)/);
  }
  assert.match(render, /return withCompany\(parseSubjectContext\(opts\?\.context\)\);/, "used only when there is no quote or job card to read");
  assert.match(
    code("src/lib/signing/complete.ts"),
    /bindCtx\(req\.quoteId, req\.jobCardId, undefined, \{ liveVehicle: false, context: req\.contextJson \}\)/,
    "the sealed PDF must show what the signer was shown",
  );
  const service = code("src/lib/signing/service.ts");
  assert.match(service, /subjectType: source\.subject\?\.type \?\? null/);
  assert.match(service, /subjectId: source\.subject\?\.id \?\? null/);
  assert.match(service, /opts\.context \? \{ contextJson: opts\.context as object \} : \{\}/);
});

// ── Completing it marks the booking ─────────────────────────────────────────

test("the booking is marked inside the completion transaction, after its row is locked first", () => {
  const complete = code("src/lib/signing/complete.ts");
  const tx = complete.slice(complete.indexOf("await prisma.$transaction(async (tx) => {", complete.indexOf("let subjectSigned = false;")));
  const end = tx.indexOf("} catch (err) {");
  const body = tx.slice(0, end);
  const lock = body.indexOf("await lockSubject(tx, req)");
  const claim = body.indexOf('status: "completed"');
  const mark = body.indexOf("subjectSigned = await completeSubject(tx, req)");
  assert.ok(lock !== -1 && claim !== -1 && mark !== -1, "all three are in the one transaction");
  assert.ok(lock < claim, "the booking is locked BEFORE the request is claimed — the order starting a new indemnity takes");
  assert.ok(claim < mark, "and marked only once the claim has succeeded (a lost claim throws before it)");
});

test("the booking is found in the request's own workspace, and only a live one is marked", () => {
  const hooks = code("src/lib/signing/subjectCompletion.ts");
  assert.match(hooks, /FROM "TestDriveBooking" WHERE id = \$\{req\.subjectId\} AND "tenantId" = \$\{req\.tenantId\} FOR UPDATE/);
  const mark = fnBody(hooks, "completeSubject");
  assert.match(mark, /if \(req\.subjectType !== TEST_DRIVE_INDEMNITY \|\| !req\.subjectId \|\| !req\.tenantId\) return false;/, "no tenant, no write");
  assert.match(mark, /where: \{ id: req\.subjectId, tenantId: req\.tenantId, deletedAt: null, indemnityStatus: \{ not: "signed" \} \}/);
  assert.match(mark, /data: \{ indemnityStatus: "signed" \}/);
  assert.doesNotMatch(mark, /throw/, "an indemnity stands whatever became of the booking — completing never refuses");
  assert.equal(TEST_DRIVE_INDEMNITY, "test_drive_indemnity", "the stored value: changing it orphans every indemnity already made");
});

test("a form rendered before the driver signed cannot save 'pending' over the signature", () => {
  const save = fnBody(code("src/app/actions/testDrives.ts"), "saveDriverControls");
  const lock = save.indexOf('FROM "TestDriveBooking" WHERE id = ${id}');
  const ask = save.indexOf('where: { subjectType: TEST_DRIVE_INDEMNITY, subjectId: id, status: "completed" }');
  const write = save.indexOf("tx.testDriveBooking.update(");
  assert.ok(lock !== -1 && ask !== -1 && write !== -1);
  assert.ok(lock < ask && ask < write, "lock the booking, ask whether a signed indemnity is on file, then write");
  assert.match(save, /const indemnityStatus = signedOnFile \? "signed" : postedIndemnity;/);
  // The booking screen holds the same line: the dropdown cannot be changed once it is signed on a screen.
  const page = code("src/app/(app)/test-drives/[id]/page.tsx");
  assert.match(page, /disabled=\{!canManage \|\| !upcoming \|\| indemnity\.kind === "signed"\}/);
});

// ── One live indemnity per booking ──────────────────────────────────────────

test("starting again replaces what was opened, and never what was signed", () => {
  const lib = code("src/lib/testDriveIndemnity.ts");
  const prepare = fnBody(lib, "prepareIndemnity");
  const bookingLock = prepare.indexOf('FROM "TestDriveBooking" WHERE id = ${bookingId} AND "tenantId" = ${tenantId} FOR UPDATE');
  const hold = prepare.indexOf("await holdIndemnityRequests(tx, { id: bookingId, tenantId })");
  const signed = prepare.indexOf('if (signed) return "signed" as const;');
  const withdraw = prepare.indexOf("await withdrawOpenIndemnity(tx, { id: bookingId, tenantId })");
  const create = prepare.indexOf("await createSignatureRequestFromDoc({");
  for (const [name, at] of Object.entries({ bookingLock, hold, signed, withdraw, create })) assert.notEqual(at, -1, `${name} is missing`);
  assert.ok(bookingLock < hold && hold < signed && signed < withdraw && withdraw < create, "booking, then its requests, then ask, then replace, then make");
  // The rule itself, in the one statement that withdraws.
  const withdrawSql = fnBody(lib, "withdrawOpenIndemnity");
  assert.match(withdrawSql, /SET "status" = 'voided'/);
  assert.match(withdrawSql, /r\."tenantId" = \$\{booking\.tenantId\}/);
  assert.match(withdrawSql, /NOT EXISTS \(\s*SELECT 1 FROM "SignatureRecipient" s WHERE s\."requestId" = r\."id" AND s\."status" = 'signed'\s*\)/);
  assert.match(withdrawSql, /await holdIndemnityRequests\(tx, /, "it waits for a signature being submitted before deciding nobody has signed");
});

test("only the driver signs: a layout asking anyone else is refused, not silently waited on", () => {
  const prepare = fnBody(code("src/lib/testDriveIndemnity.ts"), "prepareIndemnity");
  assert.match(prepare, /recipient\.role !== "viewer" && recipient\.party !== "customer"/);
  assert.match(prepare, /if \(someoneElse\) \{\s*throw new ActionRefusal\(/);
  assert.ok(prepare.indexOf("if (someoneElse)") < prepare.indexOf("await toPdf("), "refused before anything is rendered or stored");
  assert.match(prepare, /if \(!contact \|\| contact\.tenantId !== tenantId\)/, "the customer is the booking's workspace's own");
});

test("an indemnity left open does not outlive the point it was for: check-out, a cancellation, a no-show", () => {
  const actions = code("src/app/actions/testDrives.ts");
  for (const fn of ["checkOutTestDrive", "cancelTestDrive", "markTestDriveNoShow"]) {
    const body = fnBody(actions, fn);
    const update = body.indexOf("tx.testDriveBooking.update(");
    const withdraw = body.indexOf("await withdrawOpenIndemnity(tx, result)");
    assert.ok(update !== -1 && withdraw !== -1 && update < withdraw, `${fn}: in the same transaction, after the booking row is written (and so held)`);
  }
});

// ── Who may run it ──────────────────────────────────────────────────────────

test("it is the booking's permission, not the Signatures one", () => {
  const action = code("src/app/actions/testDriveIndemnity.ts");
  const start = fnBody(action, "startTestDriveIndemnity");
  assert.ok(start.indexOf("await requireTestDriveManageAccess(bookingId)") !== -1);
  assert.ok(start.indexOf("requireTestDriveManageAccess(bookingId)") < start.indexOf("prepareIndemnity("), "the booking is checked before anything is made");
  assert.match(start, /return asActionResult\(/);

  const page = code("src/app/(handover)/test-drives/[id]/indemnity/page.tsx");
  const permission = page.indexOf('requirePermission("activities.manage")');
  const access = page.indexOf("canAccessTestDriveBooking(user, id)");
  const screen = page.indexOf("<InPersonSigning");
  assert.ok(permission !== -1 && access !== -1 && screen !== -1);
  assert.ok(permission < access && access < screen, "permission, then THIS booking, then the screen that mints a pass");
  assert.match(page, /recipient\.tenantId !== booking\.tenantId/, "the signer is the booking's workspace's own");
  for (const source of [action, page]) assert.doesNotMatch(source, /signing\.manage|signing\.view/, "a salesperson needs no signing permission for this");
  // Reading the page makes nothing: a reload must show the same document, not a new one.
  assert.doesNotMatch(page, /prepareIndemnity|startTestDriveIndemnity/);
  assert.ok(existsSync(path.join(root, "src/app/(handover)/layout.tsx")), "and it sits outside the CRM shell, with the other screens handed to a customer");
});

test("a lead with a test drive coming up points at it — where its indemnity is signed", () => {
  const page = code("src/app/(app)/leads/[id]/page.tsx");
  // Only for someone who may run test drives, and only while the indemnity is outstanding.
  assert.match(page, /const testDriveToSign = automotiveOn && canBookTestDrive\s*\? await prisma\.testDriveBooking\.findFirst\(\{/);
  assert.match(page, /where: \{ leadId: lead\.id, deletedAt: null, status: \{ in: UPCOMING_TEST_DRIVE_STATUSES \}, indemnityStatus: "pending" \}/);
  assert.match(page, /\{testDriveToSign && \(\s*<Link\s+href=\{`\/test-drives\/\$\{testDriveToSign\.id\}`\}/);
  // The printed form stays: a lead with no test drive booked still needs one.
  assert.match(page, /\{automotiveOn && \(\s*<Link\s+href=\{`\/leads\/\$\{lead\.id\}\/indemnity`\}/);
});

test("the signed copy is served on the booking's own rule, in its own workspace", () => {
  const route = code("src/app/api/test-drives/[id]/indemnity/route.ts");
  const exported = route.slice(route.indexOf("export async function GET("), route.indexOf("\n}", route.indexOf("export async function GET(")) + 2);
  assert.match(
    exported.replace(/\s+/g, " "),
    /^export async function GET\([^)]*\) \{ return withActingStaffScope\(\(\) => handleGet\([^)]*\)\); \}$/,
    "a route handler has nothing above it that binds the workspace",
  );
  assert.equal(route.match(/export async function /g)?.length, 1, "one way in");
  const access = route.indexOf("canAccessTestDriveBooking(user, id)");
  const read = route.indexOf("readFile(");
  assert.ok(access !== -1 && read !== -1 && access < read);
  assert.match(route, /tenantId: booking\.tenantId,\s*status: "completed",/);
  assert.match(route, /"Cache-Control": "private, no-store"/);
});

// ── The migration ───────────────────────────────────────────────────────────

test("the migration only adds: three nullable columns and one index, all re-runnable", () => {
  const sql = src("prisma/migrations/20261010120000_signature_request_subject/migration.sql")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("--"))
    .join("\n");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "subjectType" TEXT',
    'ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "subjectId" TEXT',
    'ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "contextJson" JSONB',
    'CREATE INDEX IF NOT EXISTS "SignatureRequest_subjectType_subjectId_idx" ON "SignatureRequest"("subjectType", "subjectId")',
  ]);
  const schema = src("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model SignatureRequest {"), schema.indexOf("\n}", schema.indexOf("model SignatureRequest {")));
  assert.match(model, /\n\s+subjectType String\?\n/);
  assert.match(model, /\n\s+subjectId\s+String\?\n/);
  assert.match(model, /\n\s+contextJson Json\?\n/);
  assert.match(model, /@@index\(\[subjectType, subjectId\]\)/);
});
