import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DELIVERABLE_STATUS,
  notReadyMessage,
  vehiclesAwaitingRegistration,
  vinConflictMessage,
  vinMatch,
  type DeliveryQuoteLine,
} from "../src/lib/deliveryVehicles";
import { withStagedEvidence, type CleanupSummary, type StageFile } from "../src/lib/stagedEvidence";
import { signedPdfIsUnreferenced } from "../src/lib/signing/compensate";

/**
 * GAP #12 — two delivery flows that each did half the job.
 *
 * The Deliveries board marked the quote delivered and left its stock unit
 * "allocated" forever; the stock page delivered the unit and created a vehicle
 * but left the quote on the board, where "Mark delivered" then sent the customer
 * to register the same cart again — two vehicle records for one cart.
 *
 * Both buttons now go through lib/quoteDelivery.ts → deliverQuote.
 *
 * GAP #15 — a delivery date, an invoice / proof of payment and a deposit amount
 * could not be corrected. Each correction is now an audited action.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const delivery = src("src/lib/quoteDelivery.ts");
const fulfilment = src("src/app/actions/fulfilment.ts");
const stock = src("src/app/actions/stock.ts");

function fn(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = code.indexOf("\nexport async function ", start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

/* ── #12: one delivery ───────────────────────────────────────────────────── */

test("both delivery buttons call the ONE shared deliver function", () => {
  assert.match(fn(fulfilment, "markDelivered"), /return deliverQuote\(\{/, "Deliveries board → deliverQuote");
  assert.match(fn(stock, "deliverStockUnit"), /return deliverQuote\(\{/, "stock page → deliverQuote");
  // The guided handover reaches it through markDelivered.
  assert.match(src("src/app/actions/guidedDelivery.ts"), /return markDelivered\(quoteId, formData, signedRunIds\)/);
});

test("neither entry point keeps a private copy of the delivery", () => {
  for (const [where, body] of [
    ["markDelivered", strip(fn(fulfilment, "markDelivered"))],
    ["deliverStockUnit", strip(fn(stock, "deliverStockUnit"))],
  ] as const) {
    assert.doesNotMatch(body, /quote\.updateMany\(/, `${where} must not mark the quote delivered itself`);
    assert.doesNotMatch(body, /stockUnit\.(update|updateMany)\(/, `${where} must not move stock itself`);
    assert.doesNotMatch(body, /vehicle\.create\(/, `${where} must not create vehicles itself`);
  }
});

test("the delivery marks the quote delivered AND moves every allocated unit to delivered, in one transaction", () => {
  const body = fn(delivery, "deliverQuote");
  const tx = body.slice(body.indexOf("prisma.$transaction("));
  assert.ok(body.includes("prisma.$transaction("), "quote, stock and vehicles commit together");
  assert.match(tx, /tx\.quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId, deliveredAt: null \},\s*data: \{ deliveredAt,/);
  assert.match(tx, /tx\.stockUnit\.updateMany\(\{\s*where: \{ id: unit\.id, status: DELIVERABLE_STATUS, deletedAt: null \},\s*data: \{\s*status: "delivered"/);
  // Every unit allocated to the quote is handed over — none is left "allocated".
  assert.match(body, /stockUnit\.findMany\(\{\s*where: \{ soldQuoteId: quoteId, tenantId, deletedAt: null \}/);
  assert.match(body, /const outstanding = units\.filter\(\(unit\) => !\(DELIVERED_STOCK_STATUSES/);
});

/* ── a cart that is not ready blocks the WHOLE delivery ──────────────────── */

test("the refusal names every cart that is not ready, and why — never the customer", () => {
  const message = notReadyMessage(1042, [
    { stockNumber: "STK-0007", serial: "DNG9XX00123", status: "pdi" },
    { stockNumber: null, serial: "dng9xx00456", status: "hold" },
    { stockNumber: null, serial: null, status: "allocated" },
  ]);
  assert.match(message, /^Q-1042 can't be delivered yet/);
  assert.match(message, /STK-0007 \(still in PDI\)/);
  assert.match(message, /unit …0456 \(on hold\)/, "no stock number: last 4 of the serial only");
  assert.doesNotMatch(message, /dng9xx00456/i, "never the full VIN");
  assert.match(message, /an unnumbered unit \(PDI not started\)/);
  assert.match(message, /Nothing was changed\./);
});

test("the readiness gate runs before ANY write, and the transaction re-checks it per unit", () => {
  const body = fn(delivery, "deliverQuote");
  const gate = body.indexOf("refuse(notReadyMessage(quote.number, notReady))");
  assert.notEqual(gate, -1, "deliverQuote must refuse on a not-ready cart");
  assert.match(body, /const notReady = outstanding\.filter\(\(unit\) => unit\.status !== DELIVERABLE_STATUS\);/);
  for (const write of ["input.collectEvidence(", "prisma.$transaction(", "tx.quote.updateMany(", "tx.vehicle.create("]) {
    const at = body.indexOf(write);
    assert.ok(at > gate, `${write} must come after the readiness gate — a refusal must leave nothing behind`);
  }
  // A unit that leaves ready_for_delivery between the gate and the write matches
  // nothing, refuses inside the transaction, and rolls the quote back with it.
  assert.match(body, /if \(moved\.count !== 1\) refuse\(/);
  assert.equal(DELIVERABLE_STATUS, "ready_for_delivery");
});

test("both entry points get that same refusal — the stock page has no readiness check of its own", () => {
  const unit = strip(fn(stock, "deliverStockUnit"));
  assert.doesNotMatch(unit, /current\.status/, "a private status check would give the stock page a different answer");
  assert.doesNotMatch(fn(fulfilment, "markDelivered"), /ready_for_delivery|DELIVERABLE_STATUS/);
});

test("an existing vehicle with the unit's VIN is reused, never duplicated", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /ciExactIds\("vehicleVin", unit\.serial\)/, "case-insensitive VIN match");
  const reuse = body.indexOf("const existing = existingVehicle.get(unit.id)");
  const create = body.indexOf("tx.vehicle.create(");
  assert.ok(reuse !== -1 && create !== -1 && reuse < create, "reuse is checked before any create");
  assert.match(body.slice(reuse, create), /if \(existing\) \{[\s\S]*continue;/);
});

/* ── the reused vehicle must belong to THIS quote's customer ─────────────── */

test("VIN reuse: same customer reuses, no owner attaches, ANOTHER customer conflicts", () => {
  assert.equal(vinMatch("contact_a", "contact_a"), "reuse");
  assert.equal(vinMatch(null, "contact_a"), "attach");
  assert.equal(vinMatch("", "contact_a"), "attach");
  assert.equal(vinMatch("contact_b", "contact_a"), "conflict", "another customer's vehicle is never reused");
});

test("the conflict refusal gives the last 4 of the VIN and nothing about the other customer", () => {
  const message = vinConflictMessage("DNG9XX001234");
  assert.match(message, /^Cart …1234 is already registered to another customer — check the stock unit or transfer the vehicle first\./);
  assert.doesNotMatch(message, /DNG9XX00/, "never the full VIN");
  assert.match(message, /Nothing was changed\./);
});

test("a VIN on another customer refuses the WHOLE delivery before any write", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /select: \{ id: true, contactId: true \}/, "the owner is read with the match");
  const gate = body.indexOf('if (match === "conflict") refuse(vinConflictMessage(unit.serial));');
  assert.notEqual(gate, -1, "a conflicting owner must refuse");
  for (const write of ["input.collectEvidence(", "prisma.$transaction(", "tx.quote.updateMany(", "tx.stockUnit.updateMany(", "tx.vehicle.create("]) {
    assert.ok(body.indexOf(write) > gate, `${write} must come after the ownership check`);
  }
});

test("ownership is re-proved inside the transaction; an unowned vehicle is attached conditionally and audited", () => {
  const body = fn(delivery, "deliverQuote");
  const tx = body.slice(body.indexOf("prisma.$transaction("));
  // Reuse: still this customer's at commit time, or the lot rolls back.
  assert.match(tx, /tx\.vehicle\.count\(\{ where: \{ id: existing\.id, contactId: contact!\.id \} \}\)/);
  // Attach: only if the owner is still the one read — never overwrites a real owner.
  assert.match(tx, /tx\.vehicle\.updateMany\(\{\s*where: \{ id: existing\.id, contactId: existing\.contactId \},\s*data: \{ contactId: contact!\.id \}/);
  assert.match(tx, /if \(owned\.count !== 1\) refuse\(vinConflictMessage\(/);
  assert.match(body, /action: "vehicle\.owner_attached"/);
  // No other path writes a vehicle's owner.
  assert.equal((strip(delivery).match(/data: \{ contactId:/g) ?? []).length, 1, "exactly one owner write");
});

test("a board delivery that left its stock behind can be finished from the stock page", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /const catchUp = Boolean\(quote\.deliveredAt\);/);
  assert.match(body, /if \(catchUp && outstanding\.length === 0\) refuse\("This delivery is already marked as delivered\."\);/);
  // Still only once the cart has passed PDI: the readiness gate is not skipped.
  assert.ok(body.indexOf("const notReady") > body.indexOf("const catchUp"), "catch-up is gated like any delivery");
});

const cart = (over: Partial<DeliveryQuoteLine> = {}): DeliveryQuoteLine => ({
  productId: "rover",
  description: "Denago EV Rover XXL",
  qty: 1,
  kind: "product",
  optional: false,
  selected: true,
  colorPreference: null,
  product: { name: "Denago EV Rover XXL" },
  ...over,
});

test("a cart delivered from stock is NOT queued for a second registration", () => {
  // Two sold, one came out of stock (and got its vehicle at delivery): one left to register.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })], [{ productId: "rover" }]).length, 1);
  // Both from stock: nothing to register — this was the duplicate.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })], [{ productId: "rover" }, { productId: "rover" }]).length, 0);
  // Stock of a DIFFERENT model covers nothing on this line.
  assert.equal(vehiclesAwaitingRegistration([cart()], [{ productId: "nomad" }]).length, 1);
  // No stock: unchanged behaviour.
  assert.equal(vehiclesAwaitingRegistration([cart({ qty: 2 })]).length, 2);
});

test("the registration page and its action both use the stock-aware queue", () => {
  assert.match(src("src/app/(app)/vehicles/new/page.tsx"), /registrationQueueForQuote\(quoteId\)/);
  assert.match(src("src/app/actions/vehicles.ts"), /registrationQueueForQuote\(deliveryQuoteId\)/);
  assert.match(fn(delivery, "registrationQueueForQuote"), /soldStock: \{\s*where: \{ deletedAt: null, status: \{ in: \[\.\.\.DELIVERED_STOCK_STATUSES\] \} \}/);
});

test("each entry point keeps its sibling actions' permissions", () => {
  const board = fn(fulfilment, "markDelivered");
  assert.match(board, /requireModuleEnabled\("automotive"\)/);
  assert.match(board, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  const unit = fn(stock, "deliverStockUnit");
  assert.match(unit, /requirePermission\("stock\.manage"\)/);
  // As allocateUnit does: the quote it acts on must be one this user can reach.
  assert.match(unit, /requireQuoteAccess\(current\.soldQuoteId, "stock\.manage"\)/);
});

test("the delivery is audited — the quote and every unit handed over", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(body, /action: "fulfilment\.delivered"/);
  assert.match(body, /action: "stock\.delivered"/);
  assert.match(body, /eventType: "unit\.delivered"/);
});


/* ── evidence: kept only if referenced, deleted only if PROVABLY not ─────── */

/**
 * A fake store with real transaction semantics: writes inside `transaction`
 * land only if the callback resolves. Blobs live in `storage`, which no
 * transaction can roll back — exactly the production split.
 *
 * `ackLost` models the Q-1010 failure: Postgres COMMITS, then the client loses
 * the acknowledgement and sees an error anyway.
 *
 * `isUnreferenced` is the REAL rule deliverQuote uses (signing's
 * signedPdfIsUnreferenced), fed by a fresh count of committed rows — what
 * signedPdfIsSafeToDelete asks basePrisma outside the failed transaction.
 */
function fakeWorld(options: { probeThrows?: boolean } = {}) {
  const storage = new Map<string, Buffer>();
  const documents: Array<Record<string, unknown>> = [];
  const sideEffects: string[] = [];
  const logged: CleanupSummary[] = [];
  let key = 0;
  return {
    storage,
    documents,
    sideEffects,
    logged,
    deps: {
      save: async (buffer: Buffer) => {
        const ref = `uploads/tenant/${++key}-uuid.png`;
        storage.set(ref, buffer);
        return ref;
      },
      isUnreferenced: (storedName: string) =>
        signedPdfIsUnreferenced(storedName, {
          "SignatureRequest.signedPdfRef": async () => 0,
          "Document.storedName": async () => {
            if (options.probeThrows) throw new Error("Connection terminated unexpectedly");
            return documents.filter((row) => row.storedName === storedName).length;
          },
        }),
      remove: async (ref: string) => {
        storage.delete(ref);
      },
      onRetained: async (summary: CleanupSummary) => {
        logged.push(summary);
      },
    },
    async transaction<T>(
      fn: (tx: { document: { create: (row: Record<string, unknown>) => void } }) => Promise<T>,
      opts: { ackLost?: boolean } = {},
    ) {
      const pending: Array<Record<string, unknown>> = [];
      const result = await fn({ document: { create: (row) => void pending.push(row) } });
      documents.push(...pending); // committed only when the body resolved
      if (opts.ackLost) throw new AckLost("Connection reset before COMMIT was acknowledged");
      return result;
    },
  };
}

class LostRace extends Error {}
class AckLost extends Error {}

const twoFiles = async (stage: StageFile) => {
  const signature = await stage({ buffer: Buffer.from("png"), originalName: "sig.png", mimeType: "image/png", fileName: "Delivery signature — Q-1", tag: "delivery-signature" });
  await stage({ buffer: Buffer.from("pdf"), originalName: "note.pdf", mimeType: "application/pdf", fileName: "Delivery note — Q-1", tag: "delivery-note" });
  return { deliverySignatureRef: signature };
};

test("(a) COMMIT LANDED, ACK LOST: the transaction throws but its rows exist — the files are KEPT", async () => {
  const world = fakeWorld();
  const outcome = await withStagedEvidence(
    world.deps,
    twoFiles,
    (_evidence, documents) => world.transaction(async (tx) => {
      for (const document of documents) tx.document.create({ ...document });
      return ["vehicle_1"];
    }, { ackLost: true }),
  ).catch((error) => error);
  assert.ok(outcome instanceof AckLost, "the caller still sees the error");
  assert.equal(world.documents.length, 2, "Postgres committed both Document rows");
  assert.equal(world.storage.size, 2, "so neither file may be deleted from under them");
  for (const row of world.documents) assert.ok(world.storage.has(String(row.storedName)), "every committed row still has its file");
  assert.deepEqual(world.logged, [{ retained: 2, deleteFailed: 0 }], "the retention is logged as counts");
});

test("(b) GENUINE ROLLBACK: the compare-and-set loses, no row exists — the files are deleted, nothing else written", async () => {
  const world = fakeWorld();
  const outcome = await withStagedEvidence(
    world.deps,
    twoFiles,
    (_evidence, documents) => world.transaction(async (tx) => {
      // As deliverQuote does: the rows are created inside the transaction…
      for (const document of documents) tx.document.create({ ...document });
      // …then a concurrent change makes the stock unit's CAS match nothing.
      const moved = { count: 0 };
      if (moved.count !== 1) throw new LostRace("A stock unit on this quote changed while it was being delivered.");
      world.sideEffects.push("vehicle.create");
      return ["vehicle_1"];
    }),
  ).then(() => world.sideEffects.push("audit"), (error) => error);
  assert.ok(outcome instanceof LostRace, "the delivery is refused with the transaction's own error");
  assert.equal(world.documents.length, 0, "no Document row survives the rolled-back transaction");
  assert.equal(world.storage.size, 0, "both files are provably unreferenced, so both are deleted");
  assert.deepEqual(world.sideEffects, [], "nothing else is written — no vehicle, no audit");
  assert.deepEqual(world.logged, []);
});

test("(c) THE REFERENCE CHECK ITSELF FAILS: no answer is not a 'no' — the files are KEPT", async () => {
  const world = fakeWorld({ probeThrows: true });
  const outcome = await withStagedEvidence(
    world.deps,
    twoFiles,
    (_evidence, documents) => world.transaction(async (tx) => {
      for (const document of documents) tx.document.create({ ...document });
      throw new LostRace("refused");
    }),
  ).catch((error) => error);
  assert.ok(outcome instanceof LostRace);
  assert.equal(world.storage.size, 2, "an unanswered probe never authorises a delete");
  assert.deepEqual(world.logged, [{ retained: 2, deleteFailed: 0 }]);
});

test("a failure WHILE staging deletes what was already uploaded (nothing can reference it)", async () => {
  const world = fakeWorld();
  const outcome = await withStagedEvidence(
    world.deps,
    async (stage) => {
      await stage({ buffer: Buffer.from("pdf"), originalName: "note.pdf", mimeType: "application/pdf", fileName: "note", tag: "delivery-note" });
      throw new Error("second upload failed");
    },
    async () => world.sideEffects.push("commit"),
  ).catch((error) => error);
  assert.match(String(outcome), /second upload failed/);
  assert.equal(world.storage.size, 0);
  assert.deepEqual(world.sideEffects, [], "commit never ran");
});

test("a proven-unreferenced file whose delete fails is counted, and the refusal still stands", async () => {
  const world = fakeWorld();
  const outcome = await withStagedEvidence(
    { ...world.deps, remove: async () => { throw new Error("del failed for uploads/tenant/1-uuid.png"); } },
    async (stage) => stage({ buffer: Buffer.from("x"), originalName: "x.png", mimeType: "image/png", fileName: "x", tag: "delivery-signature" }),
    async () => { throw new LostRace("refused"); },
  ).catch((error) => error);
  assert.ok(outcome instanceof LostRace, "the original refusal is what the caller sees");
  assert.deepEqual(world.logged, [{ retained: 0, deleteFailed: 1 }], "counts only — the delete error's key is never passed on");
});

test("a successful delivery keeps its blobs and commits its rows", async () => {
  const world = fakeWorld();
  await withStagedEvidence(
    world.deps,
    async (stage) => stage({ buffer: Buffer.from("x"), originalName: "x.png", mimeType: "image/png", fileName: "x", tag: "delivery-signature" }),
    (_evidence, documents) => world.transaction(async (tx) => { for (const d of documents) tx.document.create({ ...d }); }),
  );
  assert.equal(world.storage.size, 1);
  assert.equal(world.documents.length, 1);
  assert.equal(world.documents[0].sizeBytes, 1);
  assert.deepEqual(world.logged, []);
});

test("deliverQuote reuses the signing code's proof-based check, and logs counts + quote number only", () => {
  const body = fn(delivery, "deliverQuote");
  assert.match(delivery, /import \{ signedPdfIsSafeToDelete \} from "@\/lib\/signing\/blobReferences";/, "the existing helper, not a parallel one");
  assert.match(body, /isUnreferenced: \(storedName\) => signedPdfIsSafeToDelete\(storedName, quote\.tenantId\),/, "fresh, tenant-scoped, outside the failed transaction");
  assert.match(body, /onRetained: \(\{ retained, deleteFailed \}\) =>\s*logError\(\s*"delivery-evidence-cleanup",/);
  assert.match(body, /`quote=Q-\$\{quote\.number\}`/);
  const handler = body.slice(body.indexOf("onRetained:"), body.indexOf("async (stage) =>"));
  assert.doesNotMatch(handler, /storedName|fileName|contact|error\.message/, "never a key, file name or customer");
  // The shared check counts Document rows by key, soft-delete inclusive.
  assert.match(src("src/lib/signing/blobReferences.ts"), /"Document\.storedName": \(\) =>\s*basePrisma\.document\.count\(\{ where: \{ \.\.\.tenantWhere, storedName \} \}\)/);
});


test("the delivery files its evidence through staging: rows in the transaction, nothing written before it", () => {
  const body = fn(delivery, "deliverQuote");
  const staged = body.indexOf("withStagedEvidence(");
  assert.notEqual(staged, -1, "deliverQuote must stage its evidence");
  const before = strip(body.slice(0, staged));
  assert.doesNotMatch(
    before,
    /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|logAudit\(|addStockEvent\(|emitLeadJourneyEvent\(|saveFile\(|\$transaction\(/,
    "no write, upload, audit, timeline or journey event before the staged commit",
  );
  const tx = body.slice(body.indexOf("prisma.$transaction("));
  assert.match(tx, /for \(const document of documents\) \{\s*await tx\.document\.create\(/, "Document rows are created inside the transaction");
  assert.doesNotMatch(strip(body), /prisma\.document\.create\(/, "never outside it");
  assert.match(body, /remove: deleteFile,/, "cleanup reuses the storage delete helper");
  // Audit, stock timeline and the journey event only after the commit.
  const committed = body.indexOf("const actor = {");
  for (const after of ["addStockEvent(", "logAudit(", "emitLeadJourneyEvent("]) {
    assert.ok(body.indexOf(after) > committed, `${after} must run after the commit`);
  }
  // markDelivered stages; it never uploads or files on its own.
  const board = strip(fn(fulfilment, "markDelivered"));
  assert.match(board, /collectEvidence: async \(quote, stage\)/);
  assert.doesNotMatch(board, /saveFile\(|attachStageDocument\(|document\.create\(/);
});

/* ── #15: corrections ────────────────────────────────────────────────────── */

const correctionActions = ["rescheduleDelivery", "replaceInvoice", "replaceProofOfPayment", "correctDepositAmount"] as const;

test("every correction is permissioned exactly like the stage it corrects", () => {
  for (const name of ["rescheduleDelivery", "correctDepositAmount"] as const) {
    const body = fn(fulfilment, name);
    assert.match(body, /return asFulfilmentAction\(async \(\) => \{/, `${name} binds the tenant scope`);
    assert.match(body, /requireModuleEnabled\("automotive"\)/, name);
    assert.match(body, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/, name);
  }
  const replace = fulfilment.slice(fulfilment.indexOf("async function replaceStageDocument"), fulfilment.indexOf("export async function replaceInvoice"));
  assert.match(replace, /return asFulfilmentAction\(async \(\) => \{/);
  assert.match(replace, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  for (const name of correctionActions) assert.ok(fulfilment.includes(`export async function ${name}(`), `${name} is exported`);
});

test("the corrections are where people work: desktop board AND mobile queue, one component", () => {
  const page = src("src/app/(app)/deliveries/page.tsx");
  const uses = page.match(/\{canManage && <FulfilmentCorrections quote=\{quote\} \/>\}/g) ?? [];
  assert.equal(uses.length, 2, "rendered in both the mobile and desktop views, behind deliveries.manage");
  const mobile = page.slice(page.indexOf("<MobileOnly"), page.indexOf("<DesktopOnly"));
  assert.match(mobile, /<FulfilmentCorrections quote=\{quote\} \/>/, "the mobile queue has them");
  const component = page.slice(page.indexOf("function FulfilmentCorrections"));
  for (const action of ["replaceInvoice", "correctDepositAmount", "replaceProofOfPayment", "rescheduleDelivery"]) {
    assert.match(component, new RegExp(`action=\\{${action}\\.bind\\(null, quote\\.id\\)\\}`), `${action} is offered`);
  }
});

test("the stock unit shows the recorded reservation deposit amount", () => {
  const page = src("src/app/(app)/stock/[id]/page.tsx");
  assert.match(page, /Deposit recorded: \{unit\.depositReceivedCents != null \? formatZAR\(unit\.depositReceivedCents\)/);
  assert.match(page, /r\."depositReceivedCents"/);
});

test("rescheduling is audited old → new and moves the calendar entry", () => {
  const body = fn(fulfilment, "rescheduleDelivery");
  assert.match(body, /action: "fulfilment\.delivery_rescheduled"/);
  assert.match(body, /moved from \$\{previous\.toLocaleDateString\("en-ZA"\)\} to \$\{when\.toLocaleDateString\("en-ZA"\)\}/);
  assert.match(body, /activity\.updateMany\(\{[\s\S]*note: `Fulfilment of quote Q-\$\{quote\.number\}\.`/);
  assert.match(body, /deliveryScheduledFor: previous \}/, "conditional on the date that was read");
});

test("replacing an invoice or proof of payment keeps the old file and is audited", () => {
  const replace = strip(fulfilment.slice(fulfilment.indexOf("async function replaceStageDocument"), fulfilment.indexOf("export async function replaceInvoice")));
  assert.match(replace, /attachStageDocument\(/, "the new file goes through the same private-storage helper");
  assert.match(replace, /data: \{ replacedById: nextId \}/, "the old one is versioned, not removed");
  assert.doesNotMatch(replace, /deleteFile|deleteOwnedBlob|document\.delete|deletedAt/, "never deleted");
  assert.match(replace, /"fulfilment\.invoice_replaced" : "fulfilment\.pop_replaced"/);
});

test("deposit amounts are stored in cents and every change is audited", () => {
  const paid = fn(fulfilment, "markDepositPaid");
  assert.match(paid, /data: \{ depositPaidAt: new Date\(\), depositPaidCents: amountCents \}/);
  assert.match(paid, /deposit of \$\{formatZAR\(amountCents\)\} received/);
  const corrected = fn(fulfilment, "correctDepositAmount");
  assert.match(corrected, /action: "fulfilment\.deposit_amount_corrected"/);
  assert.match(corrected, /changed from \$\{[\s\S]*?\} to \$\{formatZAR\(amountCents\)\}/);
  assert.match(fulfilment, /const cents = parseRands\(raw\);/);

  const reservation = fn(stock, "recordReservationDeposit");
  assert.match(reservation, /requirePermission\("stock\.manage"\)/);
  assert.match(reservation, /depositReceivedCents: amountCents/);
  assert.match(reservation, /action: "stock\.deposit_received"/);
});

test("the deposit columns are additive and nullable", () => {
  const sql = src("prisma/migrations/20260930150000_delivery_deposit_amounts/migration.sql");
  assert.match(sql, /ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "depositPaidCents" INTEGER;/);
  assert.match(sql, /ALTER TABLE "StockReservation" ADD COLUMN IF NOT EXISTS "depositReceivedCents" INTEGER;/);
  assert.doesNotMatch(strip(sql).replace(/^--.*$/gm, ""), /NOT NULL|DROP|UPDATE /);
});
