/**
 * READ ONLY diagnostic: are there push subscriptions, and would the tenant join
 * that `pushRecipientsForCurrentScope` performs return them?
 *
 * Run: npx tsx scripts/push-check.ts
 */
import { basePrisma } from "../src/lib/db";

async function main() {
  const total = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "PushSubscription"`;
  console.log("PushSubscription rows:", Number(total[0]?.count ?? 0));

  const rows = await basePrisma.$queryRaw<
    Array<{ userName: string; endpoint: string; createdAt: Date }>
  >`SELECT "userName", LEFT("endpoint", 45) AS endpoint, "createdAt"
    FROM "PushSubscription" ORDER BY "createdAt" DESC LIMIT 10`;
  for (const row of rows) {
    console.log(` - ${row.userName} | ${row.endpoint}... | ${row.createdAt.toISOString()}`);
  }

  const joined = await basePrisma.$queryRaw<Array<{ tenantId: string; count: bigint }>>`
    SELECT m."tenantId", COUNT(*) AS count
    FROM "PushSubscription" ps
    JOIN "TenantMember" m ON m."userId" = ps."userId"
    JOIN "Tenant" t ON t."id" = m."tenantId"
    JOIN "User" u ON u."id" = ps."userId"
    WHERE t."active" = true AND u."disabledAt" IS NULL
    GROUP BY m."tenantId"`;
  console.log(
    "reachable via the tenant join:",
    joined.map((r) => `${r.tenantId}=${Number(r.count)}`).join(", ") || "NONE",
  );

  console.log("VAPID public set:", Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY));
  console.log("VAPID private set:", Boolean(process.env.VAPID_PRIVATE_KEY));
  console.log("TENANT_ENFORCEMENT:", process.env.TENANT_ENFORCEMENT ?? "(unset)");
}

main().finally(() => basePrisma.$disconnect());
