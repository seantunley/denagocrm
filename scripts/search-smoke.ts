/**
 * READ ONLY: does the palette's search actually match a customer by name?
 *
 * Runs the same queries `searchRecords` runs, minus the permission scoping (which
 * needs a session), against the database STAGE_GATES_DB_URL names. The point is
 * to prove the MATCHING works against real rows — the "no results" the report was
 * about — not to re-test the access rules, which have their own coverage.
 *
 * Run: STAGE_GATES_DB_URL="<url>" npx tsx scripts/search-smoke.ts "<term>"
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.STAGE_GATES_DB_URL;
const term = process.argv[2] ?? "";
if (!url || !term) {
  console.error('Usage: STAGE_GATES_DB_URL="<url>" npx tsx scripts/search-smoke.ts "<term>"');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  console.log("host:", url!.match(/@([^/]+)/)?.[1] ?? "unknown");
  console.log("term:", JSON.stringify(term));

  const contains = { contains: term, mode: "insensitive" as const };

  const contacts = await prisma.contact.findMany({
    where: {
      OR: [
        { firstName: contains },
        { lastName: contains },
        { company: contains },
        { email: contains },
        { phone: contains },
      ],
    },
    select: { id: true, firstName: true, lastName: true, company: true, email: true },
    take: 5,
  });
  const leads = await prisma.lead.findMany({
    where: { OR: [{ title: contains }, { name: contains }, { email: contains }, { phone: contains }] },
    select: { id: true, title: true, name: true },
    take: 5,
  });

  console.log(`contacts: ${contacts.length}`);
  for (const c of contacts) {
    console.log(`  - ${[c.firstName, c.lastName].filter(Boolean).join(" ")}${c.company ? ` (${c.company})` : ""}`);
  }
  console.log(`leads: ${leads.length}`);
  for (const l of leads) console.log(`  - ${l.title || l.name}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
