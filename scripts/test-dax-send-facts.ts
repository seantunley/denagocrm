/**
 * REAL-DATABASE proof of DAX's send facts and its record-bound fact check (DAX roadmap, Phase 2).
 *
 *   npm run test:dax-send-facts      (DATABASE_URL = a disposable, migrated, seeded *_test database)
 *
 * A quote whose email BOUNCED must never read as plainly "sent": find_quotes and a lead's quotes say it bounced,
 * and the quote_unsigned watch tells the person to reach the customer another way. Another customer's email that
 * names a LONGER quote number must not be taken for this one's. WhatsApp delivery receipts reach the lead brief.
 * And the checker, fed these real lookup results, flags the old message's R5 000 stated as the quote's.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates. The
 * assistant's model is never called; nothing is sent.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { findQuotes, leadBrief } from "../src/lib/crmAssistant";
import { checkQuoteUnsigned } from "../src/lib/assistantWatch";
import { watchNotification } from "../src/lib/assistantWatchRules";
import { unsupportedFigures } from "../src/lib/assistantVerify";
import type { PermissionUser } from "../src/lib/permissions";

const SFX = Math.random().toString(16).slice(2, 10);
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

const id = (what: string) => `dax-send-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const outsider: PermissionUser = { id: id("out"), name: "Outsider", email: `${id("out")}@example.invalid`, role: "member" };
const STAGE = id("stage");
const C = { werner: id("c-werner"), anna: id("c-anna") };
const L = { werner: id("l-werner") };
const Q = { werner: id("q-werner"), anna: id("q-anna") };
const N = { werner: 800_000_000 + Math.floor(Math.random() * 90_000_000) };
const NA = N.werner + 1;
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

async function seed() {
  await basePrisma.user.createMany({
    data: [rep, outsider].map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })),
  });
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${outsider.id}, 'role_sales_rep', ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Send facts ${SFX}`}, 900003, '#64748b', 'pipeline_default_retail', 10, false)`;
  await basePrisma.contact.createMany({
    data: [
      { id: C.werner, tenantId: T, firstName: "Werner", lastName: `Kilian${SFX}`, ownerId: rep.id, createdById: rep.id, email: `${C.werner}@example.invalid` },
      { id: C.anna, tenantId: T, firstName: "Anna", lastName: `Jacobs${SFX}`, ownerId: rep.id, createdById: rep.id, email: `${C.anna}@example.invalid` },
    ],
  });
  await basePrisma.lead.create({
    data: { id: L.werner, tenantId: T, title: "Rover XL", name: `Werner Kilian${SFX}`, stageId: STAGE, contactId: C.werner, assignedToId: rep.id, createdById: rep.id },
  });
  const quote = (qid: string, number: number, contactId: string, leadId: string | null, deliveryCents: number) =>
    basePrisma.quote.create({
      data: {
        id: qid, number, tenantId: T, contactId, leadId, createdById: rep.id, status: "sent", createdAt: ago(72),
        items: { create: [{ tenantId: T, description: "Denago EV Rover XL", qty: 1, unitPriceCents: 25_000_000, costCents: 11_111_100, colorPreference: "White" }] },
        fees: { create: [{ tenantId: T, label: "Delivery Fee", kind: "delivery", amountCents: deliveryCents }] },
      },
    });
  await quote(Q.werner, N.werner, C.werner, L.werner, 650_000);
  await quote(Q.anna, NA, C.anna, null, 500_000);
  const email = (contactId: string, leadId: string | null, subject: string, extra: Record<string, unknown>) => ({
    tenantId: T, type: "email", direction: "outbound", subject, body: `[Quote email]\nTo: x\n\nHi`, contactId, leadId, userId: rep.id, ...extra,
  });
  await basePrisma.communication.createMany({
    data: [
      // Werner's quote email: accepted by our server, then refused by his (the MWEB case, #907).
      email(C.werner, L.werner, `Your quote Q-${N.werner} from Denago`, {
        messageId: `<${id("m1")}@example.invalid>`, openToken: id("tok1"), occurredAt: ago(48),
        bouncedAt: ago(47), bounceReason: `${C.werner}@example.invalid: High probability of spam (550)`,
      }),
      // An OLD WhatsApp promising R5 000 delivery — the quote says R6 500. Delivered to his phone.
      { tenantId: T, type: "whatsapp", direction: "outbound", body: "Delivery to Hermanus would be R5 000", contactId: C.werner, leadId: L.werner, userId: rep.id, occurredAt: ago(70), deliveredAt: ago(69) },
      // Anna's quote email: accepted, and an open detected.
      email(C.anna, null, `Your quote Q-${NA} from Denago`, { messageId: `<${id("m2")}@example.invalid>`, openToken: id("tok2"), occurredAt: ago(30), seenAt: ago(29), openCount: 1 }),
      // NEWER, on Anna, bounced — but about Q-<her number>7, a different quote. Must not be read as hers.
      email(C.anna, null, `Your quote Q-${NA}7 from Denago`, { messageId: `<${id("m3")}@example.invalid>`, occurredAt: ago(10), bouncedAt: ago(9), bounceReason: "x@example.invalid: no such user (550)" }),
    ],
  });
}

async function cleanup() {
  await basePrisma.communication.deleteMany({ where: { OR: [{ leadId: { in: Object.values(L) } }, { contactId: { in: Object.values(C) } }] } });
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: Object.values(Q) } } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: { in: Object.values(Q) } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: Object.values(Q) } } });
  await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(L) } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: Object.values(C) } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${outsider.id})`;
  await basePrisma.user.deleteMany({ where: { id: { in: [rep.id, outsider.id] } } });
}

type QuoteRow = { quote: string; sendStatus?: string };

async function main() {
  guardEnvironment();
  await seed();
  __setTenantEnforcingForTests(true);

  console.log("\nfind_quotes says what happened to the quote's email");
  const werner = await scoped(() => findQuotes(rep, { number: N.werner }));
  const w = werner.data[0] as QuoteRow;
  check("a bounced quote email reads as bounced, with what to do", /^bounced \d{4}-\d{2}-\d{2} — their mail server refused it \(High probability of spam \(550\)\).*reach them another way$/.test(w?.sendStatus ?? ""), w?.sendStatus);
  check("no customer address goes to the model", !/@/.test(JSON.stringify(werner.data)));
  check("the row the person sees says so too", /email bounced/.test(werner.rows[0]?.detail ?? ""), werner.rows[0]?.detail);
  const anna = (await scoped(() => findQuotes(rep, { number: NA }))).data[0] as QuoteRow;
  check("an opened one: accepted + open detected — never delivered/read", /^accepted by our mail server \S+; open detected \S+$/.test(anna?.sendStatus ?? ""), anna?.sendStatus);
  check("an email naming Q-<number>7 is not taken for Q-<number>", !/bounced/.test(anna?.sendStatus ?? ""));
  const outsiders = await scoped(() => findQuotes(outsider, { number: N.werner }));
  check("someone who can't open the quote still gets nothing", outsiders.data.length === 0);

  console.log("\nThe lead brief: its quotes and its messages");
  // By name: lead_brief takes only a real cuid as an id.
  const brief = (await scoped(() => leadBrief(rep, { lead: `Werner Kilian${SFX}` }))).data[0] as { quotes?: QuoteRow[]; messages?: { channel: string; receipt?: string }[] };
  check("a lead's quotes carry the bounce", /^bounced /.test(brief.quotes?.[0]?.sendStatus ?? ""), JSON.stringify(brief.quotes?.[0]));
  const wa = brief.messages?.find((m) => m.channel === "whatsapp");
  check("a WhatsApp's delivery receipt is read", /^delivered to their phone \d{4}-\d{2}-\d{2}/.test(wa?.receipt ?? ""), wa?.receipt);

  console.log("\nThe quote_unsigned watch");
  const watch = (quoteId: string | null) => ({
    id: id("w"), tenantId: T, userId: rep.id, kind: "quote_unsigned", leadId: null, quoteId, product: null,
    thresholdHours: 48, thresholdDays: null, label: "", fired: null, lastCheckedAt: null,
  });
  const one = await scoped(() => checkQuoteUnsigned(rep, T, watch(Q.werner), new Date()));
  check("a quote whose email bounced is told at once, as a bounce", Array.isArray(one) && one.length === 1 && one[0].id === `${Q.werner}:bounced` && one[0].bounced === true, JSON.stringify(one));
  const note = Array.isArray(one) ? watchNotification({ kind: "quote_unsigned", thresholdHours: 48 }, one) : "";
  check("the note says bounced — reach them another way, not 'still unsigned'", /📭 Quote email bounced — they never got it, so reach them another way:/.test(note) && !/Opened but not signed/.test(note), note);
  const annaWatch = await scoped(() => checkQuoteUnsigned(rep, T, watch(Q.anna), new Date()));
  check("an unopened, unbounced quote is not news", Array.isArray(annaWatch) && annaWatch.length === 0, JSON.stringify(annaWatch));
  const any = await scoped(() => checkQuoteUnsigned(rep, T, watch(null), new Date()));
  check("an 'any quote' watch finds the bounced one among everything", Array.isArray(any) && any.some((h) => h.id === `${Q.werner}:bounced`) && !any.some((h) => h.id.startsWith(Q.anna)));

  console.log("\nThe checker, on these real lookup results");
  const sources = ["What's the delivery on Werner's quote?", werner.data, [brief]];
  const ref = `Q-${N.werner}`;
  check("the quote's own R6 500 passes", unsupportedFigures(`${ref} has delivery at R6 500.`, sources).length === 0);
  const wrong = unsupportedFigures(`Werner's quote has delivery at R5 000.`, sources);
  check("the old message's R5 000 stated as the quote's is flagged", wrong.length === 1 && wrong[0] === `R5 000 (not on ${ref})`, JSON.stringify(wrong));
  check("…but reported as what was said, it isn't", unsupportedFigures(`${ref} has delivery at R6 500; his old WhatsApp said R5 000.`, sources).length === 0);
  check("'the quote email was delivered' is flagged", unsupportedFigures("The quote email was delivered.", sources).some((f) => f.startsWith('email "delivered"')));
}

main()
  .catch((error) => { failed++; console.error(error); })
  .finally(async () => {
    __setTenantEnforcingForTests(null);
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    await basePrisma.$disconnect();
    console.log(`\nDAX send facts: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
