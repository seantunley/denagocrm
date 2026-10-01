import { PrismaClient } from "@prisma/client";

/**
 * READ-ONLY report of the data the two old delivery flows left behind (gap #12).
 *
 *   npx tsx scripts/report-delivery-flow-drift.ts
 *
 * Writes NOTHING. Every query runs inside a `READ ONLY` transaction, so even a
 * mistake in this file cannot change a row. It prints what needs a human
 * decision; the repair itself is deliberately not automated.
 *
 * Prints ids, quote numbers and stock numbers only — no names, contact details
 * or full VINs (last 4 characters, to tell rows apart).
 *
 * What it looks for:
 *
 *  1. STUCK STOCK — the quote was marked delivered on the Deliveries board but a
 *     stock unit allocated to it never left allocated / PDI / ready / hold.
 *     Fix in the app: open the unit → "Complete delivery" (now available for
 *     exactly this case); it reuses the customer's vehicle if it has the VIN.
 *
 *  2. QUOTE LEFT ON THE BOARD — a stock unit was delivered from the stock page
 *     but its quote was never marked delivered.
 *
 *  3. DUPLICATE VEHICLES — (a) more than one live vehicle with the same VIN,
 *     ignoring case; (b) a vehicle the stock flow created automatically, plus
 *     another live vehicle for the same customer and model registered within 30
 *     days of it — the "registered it again after Mark delivered" pattern.
 *     (b) is a CANDIDATE list for review, not proof: a customer can buy two.
 */

const prisma = new PrismaClient();

type Row = Record<string, unknown>;

function lastFour(value: unknown): string | null {
  const text = typeof value === "string" ? value : null;
  return text ? `…${text.slice(-4)}` : null;
}

function print(title: string, rows: Row[]) {
  console.log(`\n== ${title}: ${rows.length} ==`);
  if (rows.length) console.table(rows);
}

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();
  console.log(`Read-only delivery drift report — database host: ${host}`);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    // FORCE RLS would otherwise hide every row from a session with no tenant
    // bound — the same trusted-system read check-production.ts does. Local to
    // this read-only transaction.
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`;

    const stuckStock = await tx.$queryRaw<Row[]>`
      SELECT su."tenantId", su."id" AS "stockUnitId", su."stockNumber", su."status",
             q."id" AS "quoteId", q."number" AS "quote", q."deliveredAt" AS "quoteDeliveredAt"
      FROM "StockUnit" su
      JOIN "Quote" q ON q."id" = su."soldQuoteId"
      WHERE su."deletedAt" IS NULL
        AND su."status" NOT IN ('delivered', 'sold')
        AND q."deliveredAt" IS NOT NULL
      ORDER BY q."deliveredAt"`;
    print("1. Stock stuck after the quote was delivered on the board", stuckStock);

    const quoteLeftOnBoard = await tx.$queryRaw<Row[]>`
      SELECT q."tenantId", q."id" AS "quoteId", q."number" AS "quote", q."status",
             COUNT(su."id")::int AS "deliveredUnits", MIN(su."deliveredAt") AS "firstUnitDeliveredAt"
      FROM "Quote" q
      JOIN "StockUnit" su ON su."soldQuoteId" = q."id"
        AND su."deletedAt" IS NULL AND su."status" IN ('delivered', 'sold')
      WHERE q."deliveredAt" IS NULL AND q."deletedAt" IS NULL
      GROUP BY q."tenantId", q."id", q."number", q."status"
      ORDER BY MIN(su."deliveredAt")`;
    print("2. Quotes still on the board although their stock was delivered", quoteLeftOnBoard);

    const sameVin = await tx.$queryRaw<Row[]>`
      SELECT v."tenantId", UPPER(v."vin") AS "vin", COUNT(*)::int AS "vehicles",
             ARRAY_AGG(v."id" ORDER BY v."createdAt") AS "vehicleIds"
      FROM "Vehicle" v
      WHERE v."deletedAt" IS NULL AND v."vin" IS NOT NULL AND v."vin" <> ''
      GROUP BY v."tenantId", UPPER(v."vin")
      HAVING COUNT(*) > 1`;
    print("3a. Live vehicles sharing a VIN (case-insensitive)", sameVin.map((row) => ({ ...row, vin: lastFour(row.vin) })));

    const candidates = await tx.$queryRaw<Row[]>`
      SELECT auto."tenantId", auto."id" AS "autoVehicleId", other."id" AS "otherVehicleId",
             auto."vin" AS "autoVin", other."vin" AS "otherVin",
             auto."createdAt" AS "autoCreatedAt", other."createdAt" AS "otherCreatedAt"
      FROM "Vehicle" auto
      JOIN "Vehicle" other
        ON other."id" <> auto."id"
       AND other."contactId" = auto."contactId"
       AND other."productId" IS NOT DISTINCT FROM auto."productId"
       AND other."deletedAt" IS NULL
       AND ABS(EXTRACT(EPOCH FROM (other."createdAt" - auto."createdAt"))) <= 30 * 86400
      WHERE auto."deletedAt" IS NULL
        AND auto."notes" LIKE 'Created automatically from stock unit %'
      ORDER BY auto."createdAt"`;
    print(
      "3b. Candidate duplicates: stock-created vehicle + another for the same customer and model within 30 days",
      candidates.map((row) => ({ ...row, autoVin: lastFour(row.autoVin), otherVin: lastFour(row.otherVin) })),
    );
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
