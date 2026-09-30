import { basePrisma } from "../src/lib/db";

/**
 * DRY RUN — READ ONLY. Lists the data the old "Mark won" left behind (gap audit
 * 2026-09-30, #11). It changes nothing: every query runs in a READ ONLY
 * transaction, so Postgres itself refuses a write.
 *
 *   npx tsx scripts/report-mark-won-gaps.ts
 *
 * 1. WON LEADS WHOSE QUOTE WAS NEVER ACCEPTED. Mark won did not accept the
 *    quote, so these deals never reached Deliveries. Someone who knows the deal
 *    must decide which quote (if any) was the one — open the lead and accept it.
 *
 * 2. POSSIBLE DUPLICATE CUSTOMERS. Mark won created a new contact whenever the
 *    lead had none linked, even if the customer was already on file. Listed are
 *    those contacts beside an older contact in the same workspace with the same
 *    email or phone. Review and merge by hand — nothing is merged here.
 *
 * Output is ids, numbers and dates only: no names, emails or phone numbers.
 */

type WonLeadRow = { tenantId: string | null; leadId: string; wonAt: Date | null; quotes: string };
type DuplicateRow = { tenantId: string | null; createdByMarkWon: string; existingContact: string; matchedOn: string; createdAt: Date };

async function main() {
  const { wonLeads, duplicates } = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const wonLeads = await tx.$queryRaw<WonLeadRow[]>`
      SELECT l."tenantId", l.id AS "leadId", l."wonAt",
             string_agg('Q-' || q.number || ' (' || q.status || ')', ', ' ORDER BY q.number) AS quotes
        FROM "Lead" l
        JOIN "Quote" q ON q."leadId" = l.id AND q."tenantId" = l."tenantId"
       WHERE l.status = 'won' AND l."deletedAt" IS NULL
         AND q."deletedAt" IS NULL AND q."supersededAt" IS NULL AND q."signedAt" IS NULL
         AND q.status IN ('draft', 'sent', 'declined')
         AND NOT EXISTS (
           SELECT 1 FROM "Quote" a
            WHERE a."leadId" = l.id AND a."tenantId" = l."tenantId"
              AND a.status = 'accepted' AND a."deletedAt" IS NULL
         )
       GROUP BY l."tenantId", l.id, l."wonAt"
       ORDER BY l."wonAt" DESC NULLS LAST`;
    const duplicates = await tx.$queryRaw<DuplicateRow[]>`
      SELECT c."tenantId", c.id AS "createdByMarkWon", o.id AS "existingContact",
             CASE WHEN c.email IS NOT NULL AND lower(trim(c.email)) = lower(trim(o.email)) THEN 'email' ELSE 'phone' END AS "matchedOn",
             c."createdAt"
        FROM "AuditLog" a
        JOIN "Contact" c ON c.id = a."contactId" AND c."tenantId" = a."tenantId"
        JOIN "Contact" o ON o."tenantId" = c."tenantId" AND o.id <> c.id AND o."deletedAt" IS NULL
                        AND o."createdAt" < c."createdAt"
                        AND ((c.email IS NOT NULL AND lower(trim(c.email)) = lower(trim(o.email)))
                          OR (c.phone IS NOT NULL AND regexp_replace(c.phone, '[^0-9]', '', 'g') <> ''
                              AND regexp_replace(c.phone, '[^0-9]', '', 'g') = regexp_replace(o.phone, '[^0-9]', '', 'g')))
       WHERE a.action = 'contact.created' AND a.summary LIKE '%from won lead'
         AND c."deletedAt" IS NULL
       ORDER BY c."createdAt" DESC`;
    return { wonLeads, duplicates };
  });

  console.log(`\n1) Won leads with an open quote that was never accepted (not on Deliveries): ${wonLeads.length}`);
  for (const row of wonLeads) {
    console.log(`   tenant ${row.tenantId} · lead ${row.leadId} · won ${row.wonAt?.toISOString().slice(0, 10) ?? "?"} · ${row.quotes}`);
  }
  console.log(`\n2) Contacts created by Mark won that match an older contact: ${duplicates.length}`);
  for (const row of duplicates) {
    console.log(`   tenant ${row.tenantId} · new ${row.createdByMarkWon} · existing ${row.existingContact} · same ${row.matchedOn} · ${row.createdAt.toISOString().slice(0, 10)}`);
  }
  console.log("\nNothing was changed. Repair by hand: accept the right quote on each lead; review duplicates before merging.");
}

main()
  .catch((error) => {
    console.error("report failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
