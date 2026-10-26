/**
 * Runs the evidence evals (evals/daxEvidence.ts) end to end: seeds a LOCAL test
 * database, asks DAX each scenario's turns in order as a sales rep (askCrm, the
 * real research + answer loop), scores them, and removes everything it made.
 *
 * NEEDS A LIVE MODEL: the workspace on that local database must have its AI
 * connection set up (Settings → AI). Without one it still proves the evidence
 * is REACHABLE — it calls the lookups directly — then stops with exit code 2
 * and says a model is needed. It never runs against anything but a *_test
 * database with NODE_ENV=test (the local sandbox recipe; never the hosted dev
 * database, which holds live mail/WhatsApp credentials).
 *
 *   NODE_ENV=test DATABASE_URL=postgresql://…/denagocrm_x_test \
 *     npx tsx --tsconfig tsconfig.scripts.json evals/runEvidenceEval.ts
 *
 * Exit 0: mean score ≥ 70. Exit 1: below. Exit 2: no model connected.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { isCodexConnected } from "../src/lib/codex";
import { askCrm } from "../src/lib/crmAssistant";
import { readDocument, searchMessages } from "../src/lib/crmAssistantEvidence";
import type { PermissionUser } from "../src/lib/permissions";
import { EVIDENCE_SCENARIOS, evidenceReport, reachedKeys, scoreScenario, type TurnTrace } from "./daxEvidence";

const SFX = Math.random().toString(36).slice(2, 8);
const T = DEFAULT_TENANT_ID;
const DAY = 86_400_000;
const cid = () => `c${SFX}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 25).padEnd(25, "0");
const rep: PermissionUser = { id: `eval-rep-${SFX}`, name: "Eval Rep", email: `eval-rep-${SFX}@example.invalid`, role: "member" };
const ROLE = `eval-role-${SFX}`;
const STAGE = `eval-stage-${SFX}`;
const CONTACT = cid();
const LEAD = cid();
const QUOTE = cid();
const QUOTE_NO = 800_000_000 + Math.floor(Math.random() * 90_000_000);
/** The records a scenario must reach, by key (daxEvidence `reached`). */
const SEEDED = { promise: cid(), bounced: cid(), quote: QUOTE, contract: cid(), scan: cid() };
const FILLER = Array.from({ length: 16 }, () => cid());
const UPLOADS = path.join(process.cwd(), "storage", "uploads");
const stored = (id: string) => `evidence-eval-${SFX}-${id}`;
const inScope = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

function guardEnvironment() {
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

async function pdf(pages: string[] | null): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages ?? ["", ""]) {
    const page = doc.addPage([595, 842]);
    if (pages) page.drawText(text, { x: 40, y: 780, size: 11, font });
    else page.drawRectangle({ x: 40, y: 200, width: 500, height: 500, color: rgb(0.8, 0.8, 0.8) });
  }
  return Buffer.from(await doc.save());
}

async function seed() {
  await basePrisma.user.create({ data: { id: rep.id, name: rep.name, email: rep.email, passwordHash: "test", role: "member", modules: "crm" } });
  await basePrisma.$executeRaw`INSERT INTO "Role" ("id", "tenantId", "name", "description", "system", "createdAt", "updatedAt") VALUES (${ROLE}, ${T}, ${`Eval rep ${SFX}`}, 'eval', false, now(), now())`;
  for (const key of ["leads.view_owned", "contacts.view_owned", "documents.view_owned", "quotes.view_owned", "activities.view"]) {
    await basePrisma.$executeRaw`INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId") VALUES (${ROLE}, ${key}, ${T})`;
  }
  await basePrisma.$executeRaw`INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES (gen_random_uuid()::text, ${rep.id}, ${ROLE}, ${T})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Eval ${SFX}`}, 900004, '#64748b', 'pipeline_default_retail', 10, false)`;
  await basePrisma.contact.create({ data: { id: CONTACT, tenantId: T, firstName: "Hendrik", lastName: "Voorbeeld", ownerId: rep.id, createdById: rep.id, city: "Paarl" } });
  await basePrisma.lead.create({ data: { id: LEAD, tenantId: T, title: "Rover XL", name: "Hendrik Voorbeeld", stageId: STAGE, contactId: CONTACT, assignedToId: rep.id, createdById: rep.id } });
  await basePrisma.quote.create({
    data: {
      id: QUOTE, number: QUOTE_NO, tenantId: T, contactId: CONTACT, leadId: LEAD, createdById: rep.id, status: "sent",
      items: { create: [{ tenantId: T, description: "Denago EV Rover XL", qty: 1, unitPriceCents: 23_500_000, costCents: 11_000_000, colorPreference: "White" }] },
      fees: { create: [{ tenantId: T, label: "Delivery Fee", kind: "delivery", amountCents: 650_000 }] },
    },
  });
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  await basePrisma.communication.createMany({
    data: [
      { id: SEEDED.promise, tenantId: T, contactId: CONTACT, leadId: LEAD, userId: rep.id, type: "whatsapp", direction: "outbound", occurredAt: ago(40), deliveredAt: ago(40), body: "Hi Hendrik, as promised we will deliver the Rover XL to Paarl for R5,000." },
      { id: SEEDED.bounced, tenantId: T, contactId: CONTACT, leadId: LEAD, userId: rep.id, type: "email", direction: "outbound", occurredAt: ago(3), subject: "Your delivery date", body: "Hi Hendrik, your Rover XL will be delivered on 14 November.", messageId: `<eval-${SFX}@example.invalid>`, bouncedAt: ago(3), bounceReason: "550 5.1.1 mailbox unavailable" },
      // Sixteen newer messages: the promise is beyond the 15 lead_brief shows, so only a search finds it.
      ...FILLER.map((id, i) => ({ id, tenantId: T, contactId: CONTACT, leadId: LEAD, userId: rep.id, type: "whatsapp", direction: i % 2 ? "outbound" : "inbound", occurredAt: ago(30 - i), body: i % 2 ? "Thanks Hendrik, noted." : "Any news on the colour options?" })),
    ],
  });
  mkdirSync(UPLOADS, { recursive: true });
  const files: [string, Buffer, string][] = [
    [SEEDED.contract, await pdf(["Sales agreement: Rover XL, white, for Hendrik Voorbeeld.", "Delivery to Paarl. Delivery fee R6,500.", "Signed in Cape Town."]), "Rover XL sales agreement (signed).pdf"],
    [SEEDED.scan, await pdf(null), "Hendrik ID scan.pdf"],
  ];
  for (const [id, bytes, fileName] of files) {
    writeFileSync(path.join(UPLOADS, stored(id)), bytes);
    await basePrisma.document.create({ data: { id, tenantId: T, fileName, storedName: stored(id), mimeType: "application/pdf", sizeBytes: bytes.length, contactId: CONTACT, uploadedById: rep.id } });
  }
}

async function cleanup() {
  for (const id of [SEEDED.contract, SEEDED.scan]) rmSync(path.join(UPLOADS, stored(id)), { force: true });
  await basePrisma.document.deleteMany({ where: { id: { in: [SEEDED.contract, SEEDED.scan] } } });
  await basePrisma.assistantRun.deleteMany({ where: { userId: rep.id } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: rep.id } });
  await basePrisma.communication.deleteMany({ where: { contactId: CONTACT } });
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: QUOTE } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: QUOTE } });
  await basePrisma.quote.deleteMany({ where: { id: QUOTE } });
  await basePrisma.lead.deleteMany({ where: { id: LEAD } });
  await basePrisma.contact.deleteMany({ where: { id: CONTACT } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" = ${rep.id}`;
  await basePrisma.$executeRaw`DELETE FROM "RolePermission" WHERE "roleId" = ${ROLE}`;
  await basePrisma.$executeRaw`DELETE FROM "Role" WHERE "id" = ${ROLE}`;
  await basePrisma.user.deleteMany({ where: { id: rep.id } });
}

/** Without a model: is the evidence each scenario needs reachable through the lookups at all? */
async function reachability(): Promise<boolean> {
  const checks: [string, boolean][] = [];
  const found = await inScope(() => searchMessages(rep, { customer: "Hendrik Voorbeeld", words: "delivery deliver" }));
  checks.push(["search_messages reaches the 40-day-old promise", reachedKeys(found.data, SEEDED).includes("promise")]);
  checks.push(["search_messages reaches the bounced email", reachedKeys(found.data, SEEDED).includes("bounced")]);
  const contract = await inScope(() => readDocument(rep, { document: SEEDED.contract }));
  checks.push(["read_document reads page 2 of the agreement", JSON.stringify(contract.data).includes("Delivery fee R6,500")]);
  const scan = await inScope(() => readDocument(rep, { document: SEEDED.scan }));
  checks.push(["read_document calls the ID copy a scan", /is a scan/.test(JSON.stringify(scan.data))]);
  for (const [name, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  return checks.every(([, ok]) => ok);
}

async function main(): Promise<number> {
  guardEnvironment();
  await seed();
  // As production runs: the workspace filter enforced, not just RLS.
  __setTenantEnforcingForTests(true);
  console.log("Evidence reachable (no model):");
  const reachable = await reachability();
  if (!(await inScope(() => isCodexConnected()))) {
    console.log("\nNEEDS A LIVE MODEL: this database's workspace has no AI connection, so the scenarios were not asked.");
    return reachable ? 2 : 1;
  }
  const scores = [];
  for (const scenario of EVIDENCE_SCENARIOS) {
    // Each scenario is its own conversation.
    await basePrisma.assistantTurn.deleteMany({ where: { userId: rep.id } });
    const traces: TurnTrace[] = [];
    for (const turn of scenario.turns) {
      const seen: unknown[] = [];
      const tools: string[] = [];
      const started = Date.now();
      const result = await inScope(() => askCrm(rep, turn.ask, null, { onLookup: (tool, data) => { tools.push(tool); seen.push(data); } }));
      traces.push({ tools, reached: reachedKeys(seen, SEEDED), answer: result.ok ? result.answer : `(failed: ${result.error})`, ms: Date.now() - started });
    }
    const score = scoreScenario(scenario, traces);
    scores.push(score);
    console.log(`\n${scenario.id}: ${score.score}`);
    traces.forEach((t, i) => console.log(`  turn ${i + 1} [${t.tools.join(", ")}] ${t.ms} ms\n    ${t.answer.replace(/\n/g, "\n    ")}`));
  }
  console.log(`\n${evidenceReport(scores)}`);
  const mean = scores.reduce((n, s) => n + s.score, 0) / (scores.length || 1);
  return reachable && mean >= 70 ? 0 : 1;
}

main()
  .then(async (code) => {
    await cleanup();
    await basePrisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.name : "error", error instanceof Error ? error.message : "");
    await cleanup().catch(() => undefined);
    await basePrisma.$disconnect();
    process.exit(1);
  });
