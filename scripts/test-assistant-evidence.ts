/**
 * REAL-DATABASE proof of DAX's evidence lookups (search_messages, open_message,
 * read_document — src/lib/crmAssistantEvidence.ts).
 *
 * A source test can show the queries are written a certain way. Only a database
 * with real permission rows, two workspaces and real PDFs can show:
 *  - what a search finds for whom: a customer's own messages and their deals the
 *    person may open — never a colleague's deal on the same customer, never
 *    another workspace's customer of the same name;
 *  - that a message reached by id obeys the same rule (and the same answer for
 *    "not yours" as for "doesn't exist");
 *  - the caps: a long email is cut at EVIDENCE_CHARS, a long PDF is read 20
 *    pages at a time and stops at the character budget, naming what is left;
 *  - a scanned PDF is refused as a scan, a non-PDF and someone else's file are
 *    not read, and a person without document access is refused;
 *  - the full-text index exists, and an email over 1 MB can still be FILED with
 *    it in place (an uncapped index expression would make that INSERT fail).
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, removes
 * every row and file it creates. The assistant's model is never called.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { EVIDENCE_CHARS, openMessage, readDocument, searchMessages } from "../src/lib/crmAssistantEvidence";
import type { PermissionUser } from "../src/lib/permissions";

const SFX = Math.random().toString(36).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

/** cuid-shaped, so the lookups treat them as ids. */
const cid = () => `c${SFX}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 25).padEnd(25, "0");
const T = DEFAULT_TENANT_ID;
const T2 = `t_evidence_${SFX}`;
const user = (what: string, role = "member"): PermissionUser => ({ id: `ev-${what}-${SFX}`, name: `Ev ${what}`, email: `ev-${what}-${SFX}@example.invalid`, role });
const rep = user("rep");
const outsider = user("out");
const noDocs = user("nodocs");
/** Same workspace, same role, nothing to do with Hendrik: must find NOTHING of his, even by id. */
const stranger = user("stranger");
const otherOwner = user("t2owner", "owner");
const ROLE = `ev-role-${SFX}`;
const ROLE_NO_DOCS = `ev-role-nodocs-${SFX}`;
const STAGE = `ev-stage-${SFX}`;
const SURNAME = `Evid${SFX}`;
const C = { hendrik: cid(), hendrik2: cid(), strangers: cid() };
const L = { mine: cid(), theirs: cid(), strangers: cid() };
const CONV = cid();
const M = { promise: cid(), askDate: cid(), bounced: cid(), long: cid(), theirDeal: cid(), phoned: cid(), otherTenant: cid(), unmatched: cid(), huge: cid() };
const D = { contract: cid(), scan: cid(), long: cid(), photo: cid(), outsiders: cid(), otherTenant: cid(), strangers: cid() };
const UPLOADS = path.join(process.cwd(), "storage", "uploads");
const stored = (id: string) => `evidence-test-${SFX}-${id}`;
const DAY = 86_400_000;

const inT = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);
const inT2 = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T2, system: false }, fn);
type Data = Record<string, unknown> & { note?: string; messages?: { id: string; excerpt: string; status?: string; deal?: string }[] };
const first = (out: { data: unknown[] }) => out.data[0] as Data;

async function textPdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    const lines = text.match(/.{1,90}(\s|$)/g) ?? [text];
    lines.slice(0, 55).forEach((line, i) => page.drawText(line.trim(), { x: 40, y: 800 - i * 14, size: 10, font }));
  }
  return Buffer.from(await doc.save());
}
/** A "scan": pages with only pictures on them — here, shapes — and no text layer at all. */
async function scanPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 40, y: 200, width: 500, height: 500, color: rgb(0.8, 0.8, 0.8) });
  }
  return Buffer.from(await doc.save());
}

async function seed() {
  await basePrisma.tenant.create({ data: { id: T2, name: `Evidence ${SFX}`, slug: T2, active: true } });
  await basePrisma.user.createMany({
    data: [rep, outsider, noDocs, stranger].map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  await basePrisma.user.create({ data: { id: otherOwner.id, name: otherOwner.name, email: otherOwner.email, passwordHash: "test", role: "owner", modules: "crm", tenantId: T2 } });
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "tenantId", "name", "description", "system", "createdAt", "updatedAt") VALUES
    (${ROLE}, ${T}, ${`Evidence rep ${SFX}`}, 'test', false, now(), now()),
    (${ROLE_NO_DOCS}, ${T}, ${`Evidence no docs ${SFX}`}, 'test', false, now(), now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned", "documents.view_owned", "quotes.view_owned"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${ROLE}, ${key}, ${T})`;
  }
  for (const key of ["leads.view_owned", "contacts.view_owned"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${ROLE_NO_DOCS}, ${key}, ${T})`;
  }
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, ${ROLE}, ${T}),
      (gen_random_uuid()::text, ${outsider.id}, ${ROLE}, ${T}),
      (gen_random_uuid()::text, ${stranger.id}, ${ROLE}, ${T}),
      (gen_random_uuid()::text, ${noDocs.id}, ${ROLE_NO_DOCS}, ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Evidence ${SFX}`}, 900003, '#64748b', 'pipeline_default_retail', 10, false)`;
  // Hendrik: the rep's customer, with the rep's deal AND a colleague's deal on him.
  // The same name in another workspace.
  await basePrisma.contact.create({ data: { id: C.hendrik, tenantId: T, firstName: "Hendrik", lastName: SURNAME, ownerId: rep.id, createdById: rep.id } });
  await basePrisma.contact.create({ data: { id: C.hendrik2, tenantId: T2, firstName: "Hendrik", lastName: SURNAME, createdById: otherOwner.id } });
  // The stranger's OWN customer, deal and file: their access lists are not empty, so a lookup by
  // Hendrik's id really runs the query (an empty list returns before it — and would prove nothing).
  await basePrisma.contact.create({ data: { id: C.strangers, tenantId: T, firstName: "Petrus", lastName: SURNAME, ownerId: stranger.id, createdById: stranger.id } });
  await basePrisma.lead.createMany({
    data: [
      { id: L.mine, tenantId: T, title: "Rover XL", name: `Hendrik ${SURNAME}`, stageId: STAGE, contactId: C.hendrik, assignedToId: rep.id, createdById: rep.id },
      { id: L.theirs, tenantId: T, title: "Fleet order", name: `Hendrik ${SURNAME}`, stageId: STAGE, contactId: C.hendrik, assignedToId: outsider.id, createdById: outsider.id },
      { id: L.strangers, tenantId: T, title: "Golf cart", name: `Petrus ${SURNAME}`, stageId: STAGE, contactId: C.strangers, assignedToId: stranger.id, createdById: stranger.id },
    ],
  });
  await basePrisma.conversation.create({ data: { id: CONV, tenantId: T, channel: "email", contactId: C.hendrik } });
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const longBody = `${"Thanks for your time today, here is everything we discussed. ".repeat(300)} Delivery is included.`;
  await basePrisma.communication.createMany({
    data: [
      { id: M.promise, tenantId: T, contactId: C.hendrik, leadId: L.mine, userId: rep.id, type: "whatsapp", direction: "outbound", occurredAt: ago(40), deliveredAt: ago(40), body: "Hi Hendrik, as promised we will deliver the Rover XL to Paarl for R5,000." },
      { id: M.askDate, tenantId: T, contactId: C.hendrik, leadId: L.mine, userId: rep.id, type: "email", direction: "inbound", occurredAt: ago(10), conversationId: CONV, subject: "Re: your quote", body: "Thanks, please confirm the delivery date." },
      { id: M.bounced, tenantId: T, contactId: C.hendrik, leadId: L.mine, userId: rep.id, type: "email", direction: "outbound", occurredAt: ago(9), conversationId: CONV, subject: "Your quote", body: "Here is the delivery date: 14 November.", messageId: `<${SFX}@example.invalid>`, bouncedAt: ago(9), bounceReason: "550 mailbox unavailable" },
      { id: M.long, tenantId: T, contactId: C.hendrik, leadId: L.mine, userId: rep.id, type: "email", direction: "outbound", occurredAt: ago(8), subject: "Summary", body: longBody, openToken: `tok${SFX}`.padEnd(30, "x"), seenAt: ago(7), openCount: 2 },
      // A colleague's deal on the same customer, in the same email thread: never the rep's to see.
      { id: M.theirDeal, tenantId: T, contactId: C.hendrik, leadId: L.theirs, userId: outsider.id, type: "email", direction: "outbound", occurredAt: ago(9.5), conversationId: CONV, subject: "Fleet", body: "Fleet delivery secret price R9,999." },
      // On the customer, on no deal: on the customer's timeline AND each of his deals'.
      { id: M.phoned, tenantId: T, contactId: C.hendrik, leadId: null, userId: rep.id, type: "call", direction: "inbound", occurredAt: ago(5), body: "Hendrik phoned about deliveries in November." },
      { id: M.otherTenant, tenantId: T2, contactId: C.hendrik2, userId: otherOwner.id, type: "whatsapp", direction: "outbound", occurredAt: ago(3), body: "Other workspace delivery R1." },
      // An inbox message nobody matched to a customer.
      { id: M.unmatched, tenantId: T, userId: rep.id, type: "email", direction: "inbound", occurredAt: ago(2), body: "Unmatched delivery enquiry." },
    ],
  });

  mkdirSync(UPLOADS, { recursive: true });
  const contract = await textPdf([
    "Sales agreement between Denago and Hendrik. Vehicle: Rover XL, white.",
    "Delivery: to Paarl. Delivery fee R6,500. Delivery within 14 days of deposit.",
    "Signatures. Signed in Cape Town.",
  ]);
  const longPdf = await textPdf(Array.from({ length: 30 }, (_, i) => `Page ${i + 1} clause. ${"Terms and conditions apply to this agreement in full. ".repeat(10)}`));
  const files: [string, Buffer, string, string, string | null, string][] = [
    [D.contract, contract, "Rover XL sales agreement (signed).pdf", "application/pdf", C.hendrik, rep.id],
    [D.scan, await scanPdf(), "Hendrik ID scan.pdf", "application/pdf", C.hendrik, rep.id],
    [D.long, longPdf, "Hendrik long terms.pdf", "application/pdf", C.hendrik, rep.id],
    [D.photo, Buffer.from("not a pdf"), "Hendrik cart photo.jpg", "image/jpeg", C.hendrik, rep.id],
    [D.strangers, contract, "Petrus agreement.pdf", "application/pdf", C.strangers, stranger.id],
  ];
  for (const [id, bytes, fileName, mimeType, contactId, uploadedById] of files) {
    writeFileSync(path.join(UPLOADS, stored(id)), bytes);
    await basePrisma.document.create({ data: { id, tenantId: T, fileName, storedName: stored(id), mimeType, sizeBytes: bytes.length, contactId, uploadedById } });
  }
  // A colleague's own file on no customer, and another workspace's agreement.
  writeFileSync(path.join(UPLOADS, stored(D.outsiders)), contract);
  await basePrisma.document.create({ data: { id: D.outsiders, tenantId: T, fileName: "Fleet agreement.pdf", storedName: stored(D.outsiders), mimeType: "application/pdf", sizeBytes: contract.length, uploadedById: outsider.id } });
  writeFileSync(path.join(UPLOADS, stored(D.otherTenant)), contract);
  await basePrisma.document.create({ data: { id: D.otherTenant, tenantId: T2, fileName: "Rover XL sales agreement (signed).pdf", storedName: stored(D.otherTenant), mimeType: "application/pdf", sizeBytes: contract.length, contactId: C.hendrik2, uploadedById: otherOwner.id } });
}

async function cleanup() {
  for (const id of Object.values(D)) rmSync(path.join(UPLOADS, stored(id)), { force: true });
  await basePrisma.document.deleteMany({ where: { id: { in: Object.values(D) } } });
  await basePrisma.communication.deleteMany({ where: { id: { in: Object.values(M) } } });
  await basePrisma.conversation.deleteMany({ where: { id: CONV } });
  await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(L) } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: Object.values(C) } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${outsider.id}, ${noDocs.id}, ${stranger.id})`;
  await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" IN (${ROLE}, ${ROLE_NO_DOCS})`;
  await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" IN (${ROLE}, ${ROLE_NO_DOCS})`;
  await basePrisma.user.deleteMany({ where: { id: { in: [rep.id, outsider.id, noDocs.id, stranger.id, otherOwner.id] } } });
  await basePrisma.tenant.deleteMany({ where: { id: T2 } });
}

async function main() {
  guardEnvironment();
  await seed();
  __setTenantEnforcingForTests(true);
  const hendrik = `Hendrik ${SURNAME}`;

  console.log("\nThe index");
  {
    const rows = await basePrisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'Communication_search_idx'`;
    check("Communication_search_idx exists, a GIN full-text index", rows.length === 1 && /USING gin \(to_tsvector/i.test(rows[0].indexdef), rows[0]?.indexdef);
    // 1.2 MB of distinct words: an uncapped to_tsvector would refuse it, and with it the INSERT that files the email.
    const huge = Array.from({ length: 150_000 }, (_, i) => `w${i}`).join(" ");
    // The control: the same text, uncapped, is more than to_tsvector will take.
    const uncapped = await basePrisma.$queryRaw`SELECT length(to_tsvector('english', ${huge}::text)) AS n`.then(() => "accepted", (e: unknown) => (e instanceof Error ? e.message : "error"));
    check("(control) uncapped, this text is too long for tsvector", /too long/i.test(uncapped), uncapped.slice(0, 160));
    let filed = true;
    try {
      await basePrisma.communication.create({ data: { id: M.huge, tenantId: T, contactId: C.hendrik, userId: rep.id, type: "email", direction: "inbound", body: huge } });
    } catch (error) {
      filed = false;
      console.log(`    (${error instanceof Error ? error.message.slice(0, 160) : "error"})`);
    }
    check("an email over 1 MB can still be filed with the index in place", filed);
  }

  console.log("\nsearch_messages — what the rep may see");
  {
    const out = first(await inT(() => searchMessages(rep, { customer: hendrik, words: "delivery deliver" })));
    const ids = (out.messages ?? []).map((m) => m.id);
    check("finds the old WhatsApp promise (stem: 'delivery' meets 'deliver')", ids.includes(M.promise), JSON.stringify(out).slice(0, 300));
    check("…with an excerpt that holds the figure", (out.messages ?? []).some((m) => m.id === M.promise && /R5,000/.test(m.excerpt)));
    check("finds the call filed on the customer and on no deal", ids.includes(M.phoned));
    check("finds the word near the END of a long email, and the excerpt is around it", (out.messages ?? []).some((m) => m.id === M.long && /Delivery is included/.test(m.excerpt) && m.excerpt.length < 400));
    check("NEVER a colleague's deal on the same customer", !ids.includes(M.theirDeal));
    check("NEVER another workspace's customer of the same name", !ids.includes(M.otherTenant));
    check("NEVER an inbox message matched to nobody", !ids.includes(M.unmatched));
    check("WhatsApp says what WhatsApp reported", (out.messages ?? []).some((m) => m.id === M.promise && /reached their phone/.test(m.status ?? "")));
    check("a bounced email says bounced", (out.messages ?? []).some((m) => m.id === M.bounced && /^bounced/.test(m.status ?? "")));
    check("an opened email: accepted + open detected, never 'read' or 'delivered'", (out.messages ?? []).some((m) => m.id === M.long && /^accepted by our mail server; open detected/.test(m.status ?? "") && !/delivered|\bread\b/.test(m.status ?? "")));
    check("each result names its deal", (out.messages ?? []).some((m) => m.id === M.promise && m.deal === "Rover XL"));

    const typo = first(await inT(() => searchMessages(rep, { customer: hendrik, words: "Novembre" })));
    check("a close spelling still finds it (pg_trgm)", (typo.messages ?? []).some((m) => m.id === M.phoned), JSON.stringify(typo).slice(0, 200));

    const filtered = first(await inT(() => searchMessages(rep, { customer: hendrik, channel: "email", direction: "outbound", from: new Date(Date.now() - 9.2 * DAY).toISOString().slice(0, 10) })));
    const fids = (filtered.messages ?? []).map((m) => m.id);
    check("channel, direction and date filters apply", fids.includes(M.bounced) && fids.includes(M.long) && !fids.includes(M.promise) && !fids.includes(M.askDate), JSON.stringify(fids));
    const none = first(await inT(() => searchMessages(rep, { customer: hendrik, words: "helicopter" })));
    check("nothing found says so — and that words match by stem, not meaning", /No message/.test(none.note ?? "") && /not by meaning/.test(none.note ?? ""));
    const capped = await inT(() => searchMessages(rep, { customer: hendrik, limit: 2 }));
    check("limit holds, and it says there are more", ((first(capped).messages ?? []).length === 2) && capped.truncated);
    const byId = first(await inT(() => searchMessages(rep, { customer: C.hendrik, words: "delivery" })));
    check("by the customer's id, the same", (byId.messages ?? []).some((m) => m.id === M.promise));
  }

  console.log("\nsearch_messages — the colleague, another workspace, nobody");
  {
    const out = first(await inT(() => searchMessages(outsider, { customer: hendrik, words: "delivery" })));
    const ids = (out.messages ?? []).map((m) => m.id);
    check("the colleague sees HIS deal and the customer's own entries", ids.includes(M.theirDeal) && ids.includes(M.phoned), JSON.stringify(ids));
    check("…and never the rep's deal", !ids.includes(M.promise) && !ids.includes(M.bounced));
    const other = first(await inT2(() => searchMessages(otherOwner, { customer: hendrik, words: "delivery" })));
    const oids = (other.messages ?? []).map((m) => m.id);
    check("another workspace's owner sees only their own Hendrik", oids.length === 1 && oids[0] === M.otherTenant, JSON.stringify(oids));
    const otherById = first(await inT2(() => searchMessages(otherOwner, { customer: C.hendrik, words: "delivery" })));
    check("…and cannot reach ours by its id", !(otherById.messages ?? []).length, JSON.stringify(otherById).slice(0, 200));
    // The access list must not be REPLACED by the id asked for (a spread `{ id }` did exactly that in read_document).
    for (const [what, needle] of [["name", hendrik], ["customer id", C.hendrik], ["deal id", L.mine]] as const) {
      const s = first(await inT(() => searchMessages(stranger, { customer: needle })));
      check(`a colleague with nothing to do with him finds nothing, by ${what}`, !(s.messages ?? []).length && /No customer or deal/.test(s.note ?? ""), JSON.stringify(s).slice(0, 200));
    }
    const strangerOpen = first(await inT(() => openMessage(stranger, { id: M.phoned })));
    check("…nor opens his customer-level message by id", /No message/.test(strangerOpen.note ?? ""));
  }

  console.log("\nopen_message");
  {
    const long = first(await inT(() => openMessage(rep, { id: M.long })));
    const msg = long.message as { text: string; cut?: string; status?: string };
    check(`a long email is cut at ${EVIDENCE_CHARS} characters, and says how much is left`, msg.text.length <= EVIDENCE_CHARS + 1 && /more characters not shown/.test(msg.cut ?? ""), `${msg.text.length}`);
    const bounced = first(await inT(() => openMessage(rep, { id: M.bounced, thread: true })));
    const thread = (bounced.thread as { id: string }[]) ?? [];
    check("a bounced email says so, with its reason", /^bounced .*550 mailbox unavailable/.test((bounced.message as { status?: string }).status ?? ""));
    check("its thread holds the customer's email", thread.some((m) => m.id === M.askDate), JSON.stringify(thread.map((m) => m.id)));
    check("…but never the colleague's deal in the same thread", !thread.some((m) => m.id === M.theirDeal));
    const theirs = first(await inT(() => openMessage(rep, { id: M.theirDeal })));
    const otherWs = first(await inT(() => openMessage(rep, { id: M.otherTenant })));
    const nobody = first(await inT(() => openMessage(rep, { id: M.unmatched })));
    const missing = first(await inT(() => openMessage(rep, { id: cid() })));
    check("a colleague's deal's message: refused", /No message/.test(theirs.note ?? ""));
    check("another workspace's message: refused", /No message/.test(otherWs.note ?? ""));
    check("an unmatched inbox message: refused", /No message/.test(nobody.note ?? ""));
    check("…all with the same words as one that doesn't exist", theirs.note === missing.note && otherWs.note === missing.note && nobody.note === missing.note);
    const fromT2 = first(await inT2(() => openMessage(otherOwner, { id: M.promise })));
    check("another workspace's OWNER cannot open ours by id", /No message/.test(fromT2.note ?? ""));
  }

  console.log("\nread_document");
  {
    const out = first(await inT(() => readDocument(rep, { document: D.contract })));
    const text = (out.text as { page: number; text: string }[]) ?? [];
    check("reads the agreement's text, page by page", out.pages === 3 && text.length === 3, JSON.stringify(out).slice(0, 200));
    check("the delivery fee is on page 2", text.find((p) => p.page === 2)?.text.includes("Delivery fee R6,500") === true);
    const byName = first(await inT(() => readDocument(rep, { document: "sales agreement", customer: hendrik })));
    check("found by words in its file name and the customer", byName.pages === 3, JSON.stringify(byName).slice(0, 200));
    const scan = first(await inT(() => readDocument(rep, { document: D.scan })));
    check("a scan is refused as a scan", /is a scan/.test(scan.note ?? "") && !("text" in scan), scan.note);
    const photo = first(await inT(() => readDocument(rep, { document: D.photo })));
    check("a photo is not read — only PDFs", /is not a PDF/.test(photo.note ?? ""));
    const long = await inT(() => readDocument(rep, { document: D.long }));
    const lp = (first(long).text as { page: number; text: string }[]) ?? [];
    const chars = lp.reduce((n, p) => n + p.text.length, 0);
    check(`a long PDF stops at the character budget (${EVIDENCE_CHARS})`, chars <= EVIDENCE_CHARS + lp.length && lp.length < 20 && long.truncated, `${chars} chars, ${lp.length} pages`);
    check("…and says which pages are left and how to read them", /read_document with fromPage \d+/.test(String(first(long).more)), String(first(long).more));
    const tail = first(await inT(() => readDocument(rep, { document: D.long, fromPage: 25 })));
    const tp = (tail.text as { page: number }[]) ?? [];
    check("fromPage reads the later pages", tp[0]?.page === 25 && tp.at(-1)?.page === 30, JSON.stringify(tp.map((p) => p.page)));
    const theirs = first(await inT(() => readDocument(rep, { document: D.outsiders })));
    check("a colleague's own file: not found", /No document you can open/.test(theirs.note ?? ""), JSON.stringify(theirs).slice(0, 300));
    const otherWs = first(await inT(() => readDocument(rep, { document: D.otherTenant })));
    check("another workspace's file: not found", /No document you can open/.test(otherWs.note ?? ""));
    const t2ByName = first(await inT2(() => readDocument(otherOwner, { document: "sales agreement" })));
    check("another workspace's owner, by name: only THEIR copy", t2ByName.link === `/api/files/${D.otherTenant}`, JSON.stringify(t2ByName).slice(0, 200));
    const strangerDoc = first(await inT(() => readDocument(stranger, { document: D.contract })));
    check("a colleague with nothing to do with him: not found by its id", /No document you can open/.test(strangerDoc.note ?? ""), JSON.stringify(strangerDoc).slice(0, 200));
    check("…while their own file reads", first(await inT(() => readDocument(stranger, { document: D.strangers }))).pages === 3);
    const refused = first(await inT(() => readDocument(noDocs, { document: D.contract })));
    check("no document access: refused", /don't have access to documents/.test(refused.note ?? ""));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    __setTenantEnforcingForTests(false);
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
