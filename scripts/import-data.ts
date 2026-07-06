/**
 * Imports data-export.json (produced by export-data.ts) into the database
 * pointed at by DATABASE_URL. Used for the SQLite -> Postgres migration.
 * Safe to re-run: skips import if users already exist.
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";

const prisma = new PrismaClient();

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.log("Target database already has users — skipping import.");
    return;
  }
  const raw = JSON.parse(fs.readFileSync("data-export.json", "utf8"));
  const dates = (obj: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (obj[k]) obj[k] = new Date(obj[k] as string);
    return obj;
  };

  for (const u of raw.users) await prisma.user.create({ data: dates(u, ["createdAt"]) });
  for (const s of raw.appSettings) await prisma.appSetting.create({ data: s });
  for (const t of raw.tags) await prisma.tag.create({ data: t });
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
        items: { create: items.map(({ jobCardId: _drop, ...item }: Record<string, unknown>) => item) },
      },
    });
  }
  for (const s of raw.serviceRecords) await prisma.serviceRecord.create({ data: dates(s, ["serviceDate", "nextDueDate", "createdAt"]) });
  for (const c of raw.communications) await prisma.communication.create({ data: dates(c, ["occurredAt", "createdAt"]) });
  for (const a of raw.activities) await prisma.activity.create({ data: dates(a, ["dueDate", "doneAt", "createdAt"]) });
  for (const d of raw.documents) await prisma.document.create({ data: dates(d, ["createdAt"]) });
  for (const t of raw.emailTemplates) await prisma.emailTemplate.create({ data: dates(t, ["createdAt"]) });
  for (const r of raw.automationRules) await prisma.automationRule.create({ data: dates(r, ["createdAt"]) });
  for (const l of raw.automationLogs) await prisma.automationLog.create({ data: dates(l, ["createdAt"]) });

  console.log("Import complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
