import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const since = new Date(Date.now() - 60 * 60 * 1000);
for (let i = 0; i < 90; i++) {
  const lead = await p.lead.findFirst({
    where: {
      source: "facebook",
      createdAt: { gte: since },
      NOT: { externalId: { startsWith: "selftest-" } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (lead) {
    console.log("LEAD ARRIVED:", JSON.stringify({ id: lead.id, name: lead.name, title: lead.title, email: lead.email, phone: lead.phone, externalId: lead.externalId, notes: lead.notes?.slice(0, 300) }));
    await p.$disconnect();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log("no facebook lead after 10 minutes");
await p.$disconnect();
process.exit(1);
