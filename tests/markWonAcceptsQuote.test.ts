import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * Gap audit 2026-09-30, #11 and #16.
 *
 *  #11 "Mark won" never accepted the quote, so the deal never reached Deliveries
 *      (which lists ACCEPTED quotes only), and it created a new contact every time.
 *  #16 A signed quote could be neither cancelled nor duplicated.
 *
 * The shared functions in lib/quoteOutcome.ts are RUN here against an in-memory
 * transaction. The wiring — that Mark won and "Accepted" both go through them —
 * is necessarily a source check, because the actions sit behind auth and a real
 * database.
 */

/* ── a tiny in-memory Prisma transaction ─────────────────────────────── */

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "def") return true; // custom-field relation filter: every value here is a quote field
    const have = row[key] ?? null;
    if (want && typeof want === "object" && !(want instanceof Date)) {
      const op = want as { in?: unknown[]; notIn?: unknown[] };
      if (op.in) return op.in.includes(have);
      if (op.notIn) return !op.notIn.includes(have);
    }
    return have === (want ?? null);
  });
}

function table(rows: Row[]) {
  return {
    rows,
    async findFirst({ where, include }: { where?: Row; include?: Row }) {
      const row = rows.find((r) => matches(r, where));
      if (!row) return null;
      if (!include) return { ...row };
      const withChildren: Row = { ...row };
      if (include.items) withChildren.items = db.quoteItem.rows.filter((i) => i.quoteId === row.id);
      if (include.fees) withChildren.fees = db.quoteFee.rows.filter((f) => f.quoteId === row.id);
      if (include.lead) withChildren.lead = db.lead.rows.find((l) => l.id === row.leadId) ?? null;
      return withChildren;
    },
    async findMany({ where }: { where?: Row }) {
      return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async updateMany({ where, data }: { where?: Row; data: Row }) {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    async createMany({ data }: { data: Row[] }) {
      rows.push(...data.map((d) => ({ ...d })));
      return { count: data.length };
    },
  };
}

const db = {
  quote: table([]),
  quoteItem: table([]),
  quoteFee: table([]),
  lead: table([]),
  signatureRequest: table([]),
  stockUnit: table([]),
  stockReservation: table([]),
  customFieldValue: table([]),
};

const tx = {
  ...db,
  quote: {
    ...db.quote,
    async create({ data }: { data: Row & { items?: { create: Row[] }; fees?: { create: Row[] } } }) {
      const { items, fees, ...quote } = data;
      const id = `q_new_${db.quote.rows.length}`;
      db.quote.rows.push({ id, deletedAt: null, signedAt: null, supersededAt: null, signToken: null, revisionOfId: null, ...quote });
      for (const item of items?.create ?? []) db.quoteItem.rows.push({ ...item, quoteId: id });
      for (const fee of fees?.create ?? []) db.quoteFee.rows.push({ ...fee, quoteId: id });
      return { id, number: quote.number };
    },
  },
  locks: [] as string[],
  async $executeRaw(strings: TemplateStringsArray) {
    tx.locks.push(strings.join("?"));
    return 1;
  },
};

/* ── stub the module's collaborators, anchored on the requesting file ── */

const audits: Row[] = [];
const fanout: string[] = [];

type Loader = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/quoteOutcome.ts")) {
    if (request === "./audit") {
      return { logAuditStrict: async (entry: Row, auditTx: unknown) => { audits.push({ ...entry, inTx: auditTx === tx }); } };
    }
    if (request === "./referrals") return { markReferralEarned: async (id: string) => { fanout.push(`referral:${id}`); } };
    if (request === "./leadJourneyEvents") return { emitLeadJourneyEvent: async (t: string, id: string) => { fanout.push(`${t}:${id}`); } };
    if (request === "./surveys") return { triggerSurvey: async (t: string) => { fanout.push(`survey:${t}`); } };
    if (request === "./errorLog") return { logError: async () => {} };
    if (request === "./numbering") return { nextQuoteNumber: async () => 2001 };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const outcome = createRequire(import.meta.url)("../src/lib/quoteOutcome.ts") as typeof import("../src/lib/quoteOutcome");
// The functions take Prisma's transaction type; this fake implements the slice they use.
const fakeTx = tx as unknown as Parameters<typeof outcome.acceptQuoteInTx>[0];

const T = "tenant_a";
const actor = { id: "u1", name: "Rep" };

function reset() {
  for (const t of Object.values(db)) t.rows.length = 0;
  audits.length = 0;
  fanout.length = 0;
  tx.locks.length = 0;
  db.lead.rows.push({ id: "lead_1", tenantId: T, title: "Rover XL", status: "open", deletedAt: null, contactId: "c1" });
  db.quote.rows.push({
    id: "q1", tenantId: T, number: 1001, status: "sent", leadId: "lead_1", contactId: "c1", fleetId: null,
    deletedAt: null, signedAt: null, supersededAt: null, deliveredAt: null, signToken: null, signedPdfHash: null,
    terms: "E&OE", taxInclusive: true, depositType: null, depositValue: null, revisionOfId: null,
  });
  db.quoteItem.rows.push({ id: "i1", quoteId: "q1", tenantId: T, description: "Rover XL", qty: 1, unitPriceCents: 10_000_00, discountPct: 0, taxRatePct: 15, costCents: 0, optional: false, selected: true, sortOrder: 0, kind: "catalogue", productId: "p1", colorPreference: null });
}

/** What app/(app)/deliveries/page.tsx selects. */
const onDeliveries = (id: string) =>
  db.quote.rows.some((q) => q.id === id && q.status === "accepted" && !q.deliveredAt && !q.supersededAt);

const shipped = (rel: string) =>
  readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
const body = (code: string, name: string) => {
  const start = code.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  return code.slice(start, code.indexOf("\nexport ", start + 1));
};

/* ── #11: one way to win a deal ──────────────────────────────────────── */

test("Mark won and 'Accepted' both go through the one shared accept", () => {
  const leads = shipped("src/app/actions/leads.ts");
  const quotes = shipped("src/app/actions/quotes.ts");
  const markWon = body(leads, "markWon");
  const setStatus = body(quotes, "setQuoteStatus");
  assert.match(markWon, /acceptQuoteInTx\(tx, chosen\.id, tenantId, user\)/, "Mark won with a quote must ACCEPT it");
  assert.match(setStatus, /acceptQuoteInTx\(tx, quoteId, tenantId, user\)/, "accepting a quote uses the same function");
  for (const fn of [markWon, setStatus]) assert.match(fn, /afterDealWon\(/, "and the same post-win effects");
  // The old accept path's private lead-win is gone, so the two cannot drift again.
  assert.doesNotMatch(setStatus, /lead\.updateMany/);
});

test("accepting the chosen quote puts the deal on Deliveries and wins the lead, audited in the transaction", async () => {
  reset();
  assert.equal(onDeliveries("q1"), false);
  const result = await outcome.acceptQuoteInTx(fakeTx, "q1", T, actor);
  assert.equal(result.kind, "accepted");
  assert.equal(result.kind === "accepted" && result.wonLeadId, "lead_1");
  assert.equal(onDeliveries("q1"), true, "Deliveries lists accepted quotes — this is what Mark won never did");
  assert.equal(db.lead.rows[0].status, "won");
  assert.deepEqual(audits.map((a) => [a.action, a.inTx]), [["quote.accepted", true], ["lead.won", true]]);
  assert.ok(tx.locks.every((sql) => sql.includes('"tenantId"')), "every lock names the tenant");

  await outcome.afterDealWon("lead_1", "c1");
  assert.deepEqual(fanout, ["referral:lead_1", "lead_won:lead_1", "survey:won"]);
});

test("a quote out for signature is not accepted behind the customer's back", async () => {
  reset();
  db.signatureRequest.rows.push({ id: "sr1", quoteId: "q1", tenantId: T, deletedAt: null, status: "sent" });
  const result = await outcome.acceptQuoteInTx(fakeTx, "q1", T, actor);
  assert.equal(result.kind, "out_for_signature");
  assert.equal(db.quote.rows[0].status, "sent");
  assert.equal(db.lead.rows[0].status, "open");
  assert.equal(audits.length, 0);
});

test("another workspace's quote is invisible to the accept", async () => {
  reset();
  const result = await outcome.acceptQuoteInTx(fakeTx, "q1", "tenant_b", actor);
  assert.equal(result.kind, "gone");
  assert.equal(db.quote.rows[0].status, "sent");
});

test("Mark won makes the user pick the quote, and never guesses", () => {
  const markWon = body(shipped("src/app/actions/leads.ts"), "markWon");
  assert.match(markWon, /if \(!choice && winnable\.length > 0\) \{\s*refuse\(/, "no choice + candidate quotes = refusal, not a guess");
  assert.match(markWon, /nothing goes to Deliveries until a quote is accepted/, "no quote says what it means");
  const dialog = shipped("src/components/MarkWonDialog.tsx");
  assert.match(dialog, /useState\(""\)/, "no quote is pre-selected");
  assert.match(dialog, /disabled=\{pending \|\| \(hasQuotes && !picked\)\}/, "and the button waits for a choice");
});

test("Mark won reuses the customer instead of creating a duplicate", () => {
  const leads = shipped("src/app/actions/leads.ts");
  const markWon = body(leads, "markWon");
  assert.doesNotMatch(markWon, /contact\.create\(/, "Mark won must never create a contact directly");
  assert.match(markWon, /linkOrCreateLeadContact\(before, user, chosen\?\.contactId \?\? null\)/);
  const helper = leads.slice(leads.indexOf("async function linkOrCreateLeadContact"));
  const order = [
    "if (lead.contactId) return lead.contactId;",
    "let contactId = knownContactId;",
    "findExistingContact({ tenantId: lead.tenantId",
    "prisma.contact.create(",
  ].map((marker) => helper.indexOf(marker));
  assert.ok(order.every((at) => at >= 0), "linked → known → canonical email/phone match → create");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "…in that order, so create is the last resort");
  assert.doesNotMatch(helper.slice(0, helper.indexOf("\nexport ")), /merge/i, "a match is linked, never merged");
});

/* ── #16: cancel and duplicate ───────────────────────────────────────── */

test("cancelling a signed quote voids live signing, releases stock, keeps the signature, and is audited", async () => {
  reset();
  Object.assign(db.quote.rows[0], { status: "accepted", signedAt: new Date(), signedPdfHash: "abc", signToken: "legacy" });
  db.signatureRequest.rows.push(
    { id: "done", quoteId: "q1", tenantId: T, deletedAt: null, status: "completed" },
    { id: "live", quoteId: "q1", tenantId: T, deletedAt: null, status: "sent" },
  );
  db.stockUnit.rows.push(
    { id: "u_alloc", tenantId: T, soldQuoteId: "q1", status: "allocated", deletedAt: null, reservedForLeadId: "lead_1", stockNumber: "S1" },
    { id: "u_pdi", tenantId: T, soldQuoteId: "q1", status: "pdi", deletedAt: null, reservedForLeadId: "lead_1", stockNumber: "S2" },
  );
  db.stockReservation.rows.push({ id: "r1", stockUnitId: "u_alloc", tenantId: T, status: "active" });

  const result = await outcome.cancelQuoteInTx(fakeTx, { quoteId: "q1", tenantId: T, reason: "Customer withdrew", actor });
  assert.equal(result.kind, "cancelled");
  const quote = db.quote.rows[0];
  assert.equal(quote.status, "cancelled");
  assert.equal(onDeliveries("q1"), false, "a cancelled deal leaves Deliveries");
  assert.ok(quote.signedAt && quote.signedPdfHash === "abc", "the signed record is kept, not wiped");
  assert.equal(quote.deletedAt, null, "cancel never deletes");
  assert.equal(quote.signToken, null, "the legacy signing link dies too");
  assert.equal(db.signatureRequest.rows.find((r) => r.id === "live")?.status, "voided");
  assert.equal(db.signatureRequest.rows.find((r) => r.id === "done")?.status, "completed", "the completed signature is untouched");
  const unit = (id: string) => db.stockUnit.rows.find((u) => u.id === id)!;
  assert.deepEqual([unit("u_alloc").status, unit("u_alloc").soldQuoteId], ["available", null]);
  assert.deepEqual([unit("u_pdi").status, unit("u_pdi").soldQuoteId], ["hold", null], "a unit mid-PDI is parked for a person to look at");
  assert.equal(db.stockReservation.rows[0].status, "released");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "quote.cancelled");
  assert.equal(audits[0].inTx, true, "the audit commits with the cancel");
  assert.match(String(audits[0].summary), /Customer withdrew/);
  assert.equal(result.kind === "cancelled" && result.wasAccepted, true, "the caller reopens the lead");
  assert.match(body(shipped("src/app/actions/quotes.ts"), "cancelQuote"), /reopenLeadInTx\(tx, cancelled\.quote\.leadId\)/);
});

test("a quote whose stock was handed over cannot be cancelled", async () => {
  reset();
  Object.assign(db.quote.rows[0], { status: "accepted" });
  db.stockUnit.rows.push({ id: "u1", tenantId: T, soldQuoteId: "q1", status: "delivered", deletedAt: null });
  const result = await outcome.cancelQuoteInTx(fakeTx, { quoteId: "q1", tenantId: T, reason: "x", actor });
  assert.equal(result.kind, "refused");
  assert.equal(db.quote.rows[0].status, "accepted");
  assert.equal(audits.length, 0);
});

test("a cancelled quote cannot be accepted, re-statused or sent for signature", async () => {
  reset();
  db.quote.rows[0].status = "cancelled";
  assert.equal((await outcome.acceptQuoteInTx(fakeTx, "q1", T, actor)).kind, "gone");
  assert.match(body(shipped("src/app/actions/quotes.ts"), "setQuoteStatus"), /before\.status === "cancelled"\) return null/);
  assert.match(shipped("src/app/actions/recordSigning.ts"), /quote\.status === "cancelled"/);
});

test("duplicating a signed quote makes a fresh, unsigned draft and leaves the original alone", async () => {
  reset();
  Object.assign(db.quote.rows[0], { status: "accepted", signedAt: new Date(), signToken: "t" });
  db.customFieldValue.rows.push({ defId: "d1", recordId: "q1", tenantId: T, value: "Blue" });
  const validUntil = new Date("2026-10-07");
  const copy = await outcome.duplicateQuoteInTx(fakeTx, { quoteId: "q1", tenantId: T, actor, validUntil });
  assert.ok(copy);
  assert.equal(copy.number, 2001, "a new number");
  const created = db.quote.rows.find((q) => q.id === copy.id)!;
  assert.equal(created.status, "draft");
  assert.equal(created.signedAt, null);
  assert.equal(created.signToken, null);
  assert.equal(created.revisionOfId, null, "a copy supersedes nothing");
  assert.equal(created.leadId, "lead_1");
  assert.equal(created.tenantId, T);
  const lines = db.quoteItem.rows.filter((i) => i.quoteId === copy.id);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].tenantId, T);
  assert.equal(db.customFieldValue.rows.filter((v) => v.recordId === copy.id).length, 1);
  assert.equal(db.signatureRequest.rows.length, 0, "no signing request is copied or created");
  const original = db.quote.rows.find((q) => q.id === "q1")!;
  assert.equal(original.status, "accepted");
  assert.equal(original.supersededAt, null);
  assert.deepEqual(audits.map((a) => [a.action, a.inTx]), [["quote.created", true]]);
});

test("Cancel and Duplicate are offered where quotes are worked on", () => {
  for (const rel of [
    "src/app/(app)/quotes/page.tsx",
    "src/app/(app)/leads/[id]/page.tsx",
    "src/components/DocumentsPanel.tsx",
  ]) {
    assert.match(shipped(rel), /<QuoteRowActions/, `${rel} must offer them`);
  }
  const editor = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  assert.match(editor, /action=\{cancelQuote\.bind\(null, savedQuote\.id\)\}/);
  assert.match(editor, /duplicateQuote\(savedQuote\.id\)/);
  // Same permissions as the siblings: status moves need change_status, a new quote needs create.
  const quotes = shipped("src/app/actions/quotes.ts");
  assert.match(body(quotes, "cancelQuote"), /requireQuoteAccess\(id, "quotes\.change_status"\)/);
  assert.match(body(quotes, "duplicateQuote"), /requireQuoteAccess\(id, "quotes\.create"\)/);
  assert.match(body(quotes, "cancelQuote"), /if \(!reason\) refuse\(/, "a cancel needs a reason");
});
