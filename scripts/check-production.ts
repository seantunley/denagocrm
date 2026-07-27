import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

// Read-only production preflight: verifies invariants that must hold before
// TENANT_ENFORCEMENT=enforce is flipped on. Exits 1 if any hard failure is
// found; warnings do not block the rollout but should be investigated.
//
// Run with: npx tsx scripts/check-production.ts
// All queries use basePrisma (bypass_rls='on') so FORCE RLS does not hide rows.

type CountRow = { count: bigint };
type IdNameRow = { id: string; name: string };

async function count(p: Promise<CountRow[]>): Promise<number> {
  return Number((await p)[0]?.count ?? 0n);
}

async function main() {
  const failures: string[] = [];
  const warnings: string[] = [];

  // ── 1. One-user-one-tenant: no user is a member of more than one tenant ────
  const multiTenantUsers = await basePrisma.$queryRaw<{ userId: string; count: bigint }[]>`
    SELECT "userId", COUNT(*) AS count
    FROM "TenantMember"
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  `;
  if (multiTenantUsers.length > 0) {
    failures.push(
      `${multiTenantUsers.length} user(s) belong to more than one tenant: ` +
        multiTenantUsers.map((r) => r.userId).join(", "),
    );
  }

  // ── 2. Founding tenant exists with a valid ownerUserId ─────────────────────
  const foundingTenant = await basePrisma.tenant.findUnique({
    where: { id: DEFAULT_TENANT_ID },
    select: { id: true, name: true, ownerUserId: true, active: true },
  });
  if (!foundingTenant) {
    failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" not found`);
  } else {
    if (!foundingTenant.active) {
      failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" is suspended (active=false)`);
    }
    if (!foundingTenant.ownerUserId) {
      failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" has no ownerUserId`);
    } else {
      const ownerExists = await basePrisma.user.findUnique({
        where: { id: foundingTenant.ownerUserId },
        select: { id: true },
      });
      if (!ownerExists) {
        failures.push(
          `Founding tenant ownerUserId "${foundingTenant.ownerUserId}" does not exist in User`,
        );
      }
    }
  }

  // ── 3. Every active tenant has at least one member ─────────────────────────
  const tenantsWithNoMembers = await basePrisma.$queryRaw<IdNameRow[]>`
    SELECT t."id", t."name"
    FROM "Tenant" t
    LEFT JOIN "TenantMember" tm ON tm."tenantId" = t."id"
    WHERE t."active" = true
    GROUP BY t."id", t."name"
    HAVING COUNT(tm."userId") = 0
  `;
  if (tenantsWithNoMembers.length > 0) {
    failures.push(
      `${tenantsWithNoMembers.length} active tenant(s) have zero members: ` +
        tenantsWithNoMembers.map((r) => `${r.name} (${r.id})`).join(", "),
    );
  }

  // ── 4. No orphaned active users (active = not disabled, not deleted) ────────
  const orphanedUsers = await basePrisma.$queryRaw<{ id: string; email: string }[]>`
    SELECT u."id", u."email"
    FROM "User" u
    LEFT JOIN "TenantMember" tm ON tm."userId" = u."id"
    WHERE u."disabledAt" IS NULL
      AND u."deletedAt" IS NULL
      AND tm."userId" IS NULL
  `;
  if (orphanedUsers.length > 0) {
    failures.push(
      `${orphanedUsers.length} active user(s) have no TenantMember row: ` +
        orphanedUsers.map((r) => r.email).join(", "),
    );
  }

  // ── 5. tenantId backfill: no NULL tenantId on active rows in key tables ────
  const nullChecks: { label: string; query: Promise<CountRow[]> }[] = [
    {
      label: "Contact",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Contact" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "Lead",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Lead" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "Vehicle",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Vehicle" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "Quote",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Quote" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "JobCard",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "JobCard" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "Communication",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Communication" WHERE "tenantId" IS NULL`,
    },
    {
      label: "Document",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "Document" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
    {
      label: "StockUnit",
      query: basePrisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM "StockUnit" WHERE "tenantId" IS NULL AND "deletedAt" IS NULL`,
    },
  ];
  for (const { label, query } of nullChecks) {
    const n = await count(query);
    if (n > 0) {
      failures.push(`${n} active ${label} row(s) have tenantId IS NULL`);
    }
  }

  // ── 6. System roles: 7 roles present in the founding tenant ───────────────
  const SYSTEM_ROLE_IDS = [
    "role_crm_admin",
    "role_sales_manager",
    "role_sales_rep",
    "role_marketing",
    "role_workshop_manager",
    "role_technician",
    "role_auditor",
  ];
  const foundRoles = await basePrisma.role.findMany({
    where: { id: { in: SYSTEM_ROLE_IDS }, tenantId: DEFAULT_TENANT_ID },
    select: { id: true },
  });
  const missingRoles = SYSTEM_ROLE_IDS.filter((id) => !foundRoles.find((r) => r.id === id));
  if (missingRoles.length > 0) {
    failures.push(`Missing system roles in founding tenant: ${missingRoles.join(", ")}`);
  }

  // ── 7. User.tenantId backfill: active users should have tenantId set ───────
  const usersWithoutTenantId = await count(
    basePrisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::bigint AS count FROM "User"
      WHERE "tenantId" IS NULL AND "disabledAt" IS NULL AND "deletedAt" IS NULL
    `,
  );
  if (usersWithoutTenantId > 0) {
    warnings.push(
      `${usersWithoutTenantId} active user(s) have User.tenantId IS NULL (denormalized field — TenantMember is authoritative)`,
    );
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const total = await basePrisma.tenant.count();
  const active = await basePrisma.tenant.count({ where: { active: true } });
  const userCount = await basePrisma.user.count({ where: { disabledAt: null, deletedAt: null } });
  console.log(`\nProduction preflight — ${active}/${total} active tenants, ${userCount} active users\n`);

  if (warnings.length > 0) {
    console.log("WARNINGS (investigate before enforcement):");
    for (const w of warnings) console.log(`  ⚠  ${w}`);
    console.log();
  }

  if (failures.length > 0) {
    console.log("FAILURES (must resolve before TENANT_ENFORCEMENT=enforce):");
    for (const f of failures) console.log(`  ✗  ${f}`);
    console.log();
    process.exit(1);
  }

  console.log("All checks passed. Safe to enable TENANT_ENFORCEMENT=enforce.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
