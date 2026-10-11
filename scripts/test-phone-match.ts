/**
 * REAL-DATABASE proof that a DELETED lead does not own a phone number.
 *
 * matchByPhone runs raw SQL, so the soft-delete filter is not applied for it;
 * the predicate has to be in the query. A source test can show the words are
 * there. Only a database can show what they do: on 2026-10-11 a number on a
 * lead binned three months earlier still matched, so that person's WhatsApp
 * messages were filed on the deleted lead — where nobody sees them — and the
 * number could not be linked to the assistant ("on a customer record").
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates. Nothing is sent anywhere.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { matchByPhone, recordInboundWhatsApp } from "../src/lib/whatsapp";

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

// Numbers nobody else in the test database has: 2783 + seven random digits.
const numbers: string[] = [];
const newNumber = () => { const n = `2783${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`; numbers.push(n); return n; };
const leadIds: string[] = [];
// A stage of its own: a lead needs one, and which one is beside the point.
const stageId = `phone-match-stage-${SFX}`;
/** A lead on `digits`, stored the way people type it (spaces, leading 0). `deleted`: binned. */
async function lead(label: string, digits: string, opts: { deleted?: boolean; status?: string } = {}) {
  const local = `0${digits.slice(2, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  const row = await basePrisma.lead.create({
    data: {
      tenantId: DEFAULT_TENANT_ID, stageId, title: `${label} ${SFX}`, name: `${label} ${SFX}`, phone: local,
      status: opts.status ?? "open", deletedAt: opts.deleted ? new Date(Date.now() - 90 * 86_400_000) : null,
    },
    select: { id: true },
  });
  leadIds.push(row.id);
  return row.id;
}
const scoped = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: DEFAULT_TENANT_ID } as never, fn);

async function cleanup() {
  const contacts = await basePrisma.contact.findMany({ where: { OR: numbers.flatMap((n) => [{ whatsapp: `+${n}` }, { phone: `+${n}` }]) }, select: { id: true } });
  const contactIds = contacts.map((c) => c.id);
  await basePrisma.communication.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { contactId: { in: contactIds } }] } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { contactId: { in: contactIds } }] } });
  await basePrisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await basePrisma.contact.deleteMany({ where: { id: { in: contactIds } } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${stageId}`;
}

async function main() {
  guardEnvironment();
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${stageId}, ${DEFAULT_TENANT_ID}, ${`Phone match stage ${SFX}`}, 900001, '#64748b', 'pipeline_default_retail', 10, false)
  `;

  console.log("\nThe control: an open lead owns its number");
  const live = newNumber();
  const liveLead = await lead("Live", live);
  {
    const m = await scoped(() => matchByPhone(live));
    check("an open lead is matched by its number", m.leadId === liveLead && !m.ambiguous, JSON.stringify(m));
  }

  console.log("\nA deleted lead owns nothing");
  const binned = newNumber();
  const binnedLead = await lead("Binned", binned, { deleted: true });
  {
    const m = await scoped(() => matchByPhone(binned));
    check("a number only on a deleted lead matches nobody", m.leadId === null && m.contactId === null && !m.ambiguous, JSON.stringify(m));
  }

  console.log("\nAn open lead and a deleted lead on the same number");
  const shared = newNumber();
  const sharedDeleted = await lead("Old enquiry", shared, { deleted: true }); // created FIRST: oldest-first would pick it
  const sharedLive = await lead("New enquiry", shared);
  {
    const m = await scoped(() => matchByPhone(shared));
    check("only the open lead is considered", m.leadId === sharedLive, JSON.stringify(m));
    check("…and never the deleted one, although it is older", m.leadId !== sharedDeleted);
    check("…and one live record is not 'ambiguous'", m.ambiguous === false);
  }

  console.log("\nA message from a number on a deleted lead is filed where someone will see it");
  {
    await scoped(() => recordInboundWhatsApp(binned, "Returning Customer", `hello again ${SFX}`, `wamid.${SFX}.1`));
    const onDeleted = await basePrisma.communication.count({ where: { leadId: binnedLead } });
    const filed = await basePrisma.communication.findFirst({ where: { body: `hello again ${SFX}` }, select: { leadId: true, contactId: true } });
    check("nothing is filed on the deleted lead", onDeleted === 0, `${onDeleted} message(s)`);
    check("the message exists, on a contact", Boolean(filed?.contactId) && filed?.leadId === null, JSON.stringify(filed));
  }
}

main()
  .catch((error) => { failed++; console.error("\nUNEXPECTED ERROR", error); })
  .finally(async () => {
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
