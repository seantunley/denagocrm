/**
 * Imports data-export.json (produced by export-data.ts) into the database
 * pointed at by DATABASE_URL. Used for the SQLite -> Postgres migration.
 *
 * NOT globally resumable: the run is skipped entirely once ANY user exists, so a
 * failure PART-WAY through leaves a partial import that the next run treats as
 * complete. Each imported user + its founding membership are atomic (transaction
 * below), but full-restore idempotency / explicit completion tracking is still
 * needed before relying on this for disaster recovery.
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import { ensureFoundingMembership } from "../src/lib/provisioning";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const prisma = new PrismaClient();

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.log("Target database already has users — skipping import.");
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = JSON.parse(fs.readFileSync("data-export.json", "utf8"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dates = (obj: any, keys: string[]): any => {
    for (const k of keys) if (obj[k]) obj[k] = new Date(obj[k] as string);
    return obj;
  };

  for (const u of raw.users) {
    // Each user + its founding membership in ONE transaction, so a failure can't
    // leave a tenantless user (which the "skip if any users exist" guard would then
    // never repair on rerun). Every imported user is a Denago user (single-tenant
    // SQLite→Postgres restore); shared provisioning service, same as seed/createUser.
    await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: dates(u, ["createdAt"]) });
      await ensureFoundingMembership(tx, created.id);
    });
  }
  for (const s of raw.appSettings) await prisma.appSetting.create({ data: s });
  // Legacy SQLite export predates multi-tenancy: stamp the founding tenant
  // (Tag.tenantId is NOT NULL and tenant-scoped uniqueness is (tenantId, name)).
  for (const t of raw.tags) await prisma.tag.create({ data: { ...t, tenantId: t.tenantId ?? DEFAULT_TENANT_ID } });
  for (const p of raw.products) {
    const { colors, ...product } = p;
    await prisma.product.create({
      data: {
        ...dates(product, ["createdAt"]),
        colors: { create: colors.map((c: { name: string }) => ({ name: c.name })) },
      },
    });
  }
  for (const c of raw.contacts) {
    const { tags, ...contact } = c;
    await prisma.contact.create({
      data: {
        ...dates(contact, ["createdAt", "updatedAt"]),
        tags: { connect: tags },
      },
    });
  }
  for (const s of raw.pipelineStages) await prisma.pipelineStage.create({ data: s });
  for (const l of raw.leads) await prisma.lead.create({ data: dates(l, ["createdAt", "updatedAt"]) });
  for (const v of raw.vehicles) await prisma.vehicle.create({ data: dates(v, ["purchaseDate", "createdAt"]) });
  for (const m of raw.mileageLogs) await prisma.mileageLog.create({ data: dates(m, ["recordedAt"]) });
  for (const j of raw.jobCards) {
    const { items, ...jobCard } = j;
    await prisma.jobCard.create({
      data: {
        ...dates(jobCard, ["openedAt", "completedAt", "createdAt", "updatedAt"]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: { create: items.map(({ jobCardId: _drop, ...item }: any) => item) },
      },
    });
  }
  for (const s of raw.serviceRecords) await prisma.serviceRecord.create({ data: dates(s, ["serviceDate", "nextDueDate", "createdAt"]) });
  for (const c of raw.communications) await prisma.communication.create({ data: dates(c, ["occurredAt", "createdAt"]) });
  for (const a of raw.activities) await prisma.activity.create({ data: dates(a, ["dueDate", "doneAt", "createdAt"]) });
  for (const d of raw.documents) await prisma.document.create({ data: dates(d, ["createdAt"]) });
  for (const t of raw.emailTemplates) await prisma.emailTemplate.create({ data: dates(t, ["createdAt"]) });
  // automationRules is gone — the AutomationRule engine was retired and its
  // table dropped (20260802120000_retire_automation_rules). An older export file
  // still carrying that key imports fine; it is ignored.
  //
  // automationLogs did NOT vanish: that migration archived every row into
  // RetiredAutomationLog. Restore from either shape — a pre-migration export
  // still carries its audit trail across, it just lands in the archive table
  // without the denormalised rule columns the migration could still read.
  for (const l of raw.retiredAutomationLogs ?? [])
    await prisma.retiredAutomationLog.create({ data: dates(l, ["createdAt", "archivedAt"]) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const l of (raw.automationLogs ?? []) as any[])
    await prisma.retiredAutomationLog.create({
      data: dates(
        { id: l.id, tenantId: l.tenantId ?? null, ruleId: l.ruleId, leadId: l.leadId, note: l.note ?? null, createdAt: l.createdAt },
        ["createdAt"],
      ),
    });

  console.log("Import complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
