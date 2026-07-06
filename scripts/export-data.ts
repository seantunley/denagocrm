/** Exports all data to data-export.json (used when migrating SQLite -> Postgres). */
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
const prisma = new PrismaClient();
async function main() {
  const data = {
    users: await prisma.user.findMany(),
    appSettings: await prisma.appSetting.findMany(),
    products: await prisma.product.findMany({ include: { colors: true } }),
    tags: await prisma.tag.findMany(),
    contacts: await prisma.contact.findMany({ include: { tags: { select: { id: true } } } }),
    pipelineStages: await prisma.pipelineStage.findMany(),
    leads: await prisma.lead.findMany(),
    vehicles: await prisma.vehicle.findMany(),
    mileageLogs: await prisma.mileageLog.findMany(),
    jobCards: await prisma.jobCard.findMany({ include: { items: true } }),
    serviceRecords: await prisma.serviceRecord.findMany(),
    communications: await prisma.communication.findMany(),
    activities: await prisma.activity.findMany(),
    documents: await prisma.document.findMany(),
    emailTemplates: await prisma.emailTemplate.findMany(),
    automationRules: await prisma.automationRule.findMany(),
    automationLogs: await prisma.automationLog.findMany(),
  };
  fs.writeFileSync("data-export.json", JSON.stringify(data, null, 2));
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length]));
  console.log("Exported:", JSON.stringify(counts));
}
main().finally(() => prisma.$disconnect());
