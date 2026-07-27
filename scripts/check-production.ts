import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";

// Read-only production preflight: verifies invariants that MUST hold before
// TENANT_ENFORCEMENT=enforce is flipped on. Exits 1 if any hard failure is found.
//
// Run with: npx tsx scripts/check-production.ts
// All queries use basePrisma (bypass_rls='on') so FORCE RLS does not hide rows.
//
// This is a DB-level preflight. It does NOT replace the manual smoke test the
// deploy runbook requires AFTER migrations and BEFORE enabling enforcement:
// actually log in as the founding owner and open /platform/tenants. See
// DEPLOYMENT-SEQUENCE.md.

type CountRow = { count: bigint };
type IdNameRow = { id: string; name: string };

async function rawCount(sql: Promise<CountRow[]>): Promise<number> {
  return Number((await sql)[0]?.count ?? 0);
}

/** COUNT(*) for a code-defined (DMMF) table name — safe from injection. */
async function countTable(table: string, whereClause: string): Promise<number> {
  const rows = await basePrisma.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*)::bigint AS count FROM "${table}" WHERE ${whereClause}`,
  );
  return Number(rows[0]?.count ?? 0);
}

type CompositeFk = { child: string; childCol: string; parent: string };

/**
 * Parse every composite tenant FK from the migration SQL — the EXACT definitions
 * Postgres validates: `FOREIGN KEY ("tenantId", <col>) REFERENCES <Parent>("tenantId","id")`.
 * Table/column identifiers come only from our own migration files (not user input),
 * so they are safe to interpolate. De-duped by child.col→parent (constraints are
 * re-declared across the supplement migrations under duplicate_object guards).
 */
function readCompositeTenantFks(): CompositeFk[] {
  const dir = join(process.cwd(), "prisma", "migrations");
  const re =
    /ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+"\s+FOREIGN KEY \("tenantId",\s*"(\w+)"\)\s+REFERENCES "(\w+)"\s*\(\s*"tenantId",\s*"id"\s*\)/g;
  const seen = new Set<string>();
  const out: CompositeFk[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let sql: string;
    try {
      sql = readFileSync(join(dir, entry.name, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const [, child, childCol, parent] = m;
      const key = `${child}.${childCol}->${parent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ child, childCol, parent });
    }
  }
  return out;
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

  // ── 2. Founding tenant + its owner: the lockout-prevention checks ──────────
  //    Any of these means the platform owner cannot get back in once enforcement
  //    is live, so every one is a HARD failure.
  const foundingTenant = await basePrisma.tenant.findUnique({
    where: { id: DEFAULT_TENANT_ID },
    select: { id: true, name: true, ownerUserId: true, active: true },
  });
  if (!foundingTenant) {
    failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" not found`);
  } else {
    if (!foundingTenant.active) {
      failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" is inactive (active=false) — owner would resolve to no tenant`);
    }
    if (!foundingTenant.ownerUserId) {
      failures.push(`Founding tenant "${DEFAULT_TENANT_ID}" has no ownerUserId`);
    } else {
      // disabledAt is a raw-SQL-managed security column absent from the Prisma
      // User model, so fetch the owner (and its membership) via raw SQL.
      const ownerRows = await basePrisma.$queryRaw<
        {
          id: string;
          role: string;
          tenantId: string | null;
          disabledAt: Date | null;
          deletedAt: Date | null;
          passwordHash: string | null;
          hasMembership: boolean;
        }[]
      >`
        SELECT u."id", u."role", u."tenantId", u."disabledAt", u."deletedAt", u."passwordHash",
          EXISTS(
            SELECT 1 FROM "TenantMember" tm
            WHERE tm."userId" = u."id" AND tm."tenantId" = ${DEFAULT_TENANT_ID}
          ) AS "hasMembership"
        FROM "User" u
        WHERE u."id" = ${foundingTenant.ownerUserId}
      `;
      const owner = ownerRows[0];
      if (!owner) {
        failures.push(`Founding tenant ownerUserId "${foundingTenant.ownerUserId}" does not exist in User`);
      } else {
        if (owner.disabledAt !== null) failures.push(`Founding owner ${owner.id} is disabled (disabledAt set) — cannot sign in`);
        if (owner.deletedAt !== null) failures.push(`Founding owner ${owner.id} is soft-deleted (deletedAt set)`);
        if (owner.role !== "owner") failures.push(`Founding owner ${owner.id} has role "${owner.role}", expected "owner"`);
        if (owner.tenantId !== DEFAULT_TENANT_ID) {
          failures.push(`Founding owner ${owner.id} has User.tenantId "${owner.tenantId}", expected "${DEFAULT_TENANT_ID}"`);
        }
        if (!owner.hasMembership) failures.push(`Founding owner ${owner.id} has no TenantMember row for the founding tenant`);
        if (!owner.passwordHash) failures.push(`Founding owner ${owner.id} has no passwordHash — cannot log in`);
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

  // ── 5. NULL tenantId on EVERY tenant-scoped table (generated from the schema) ─
  //    FORCE RLS filters each of these tables on tenantId, so a NULL row would
  //    vanish from every tenant-scoped query after enforcement. Composite-FK
  //    validation does NOT catch this — a NULL FK column doesn't violate its FK.
  //    The list is derived from the SAME classification the guard uses
  //    (GLOBAL_MODELS opt-out) via the Prisma DMMF, so a newly-added tenant table
  //    is covered automatically instead of being silently skipped.
  const scopedTables = Prisma.dmmf.datamodel.models
    .filter((m) => !GLOBAL_MODELS.has(m.name))
    .filter((m) => m.fields.some((f) => f.name === "tenantId"))
    .map((m) => ({
      table: m.dbName ?? m.name,
      hasDeletedAt: m.fields.some((f) => f.name === "deletedAt"),
    }));

  console.log(`Checking ${scopedTables.length} tenant-scoped tables for NULL tenantId…`);
  for (const { table, hasDeletedAt } of scopedTables) {
    // Live rows only where the table supports soft-delete — a trashed row that is
    // about to be purged shouldn't block the rollout.
    const where = hasDeletedAt ? `"tenantId" IS NULL AND "deletedAt" IS NULL` : `"tenantId" IS NULL`;
    const n = await countTable(table, where);
    if (n > 0) failures.push(`${n} ${hasDeletedAt ? "live " : ""}${table} row(s) have tenantId IS NULL`);
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

  // ── 7. Active users MUST have User.tenantId set (HARD failure) ─────────────
  //    The User RLS policy filters on User.tenantId; an active user with NULL
  //    becomes invisible to tenant-scoped user queries after enforcement.
  const usersWithoutTenantId = await rawCount(
    basePrisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::bigint AS count FROM "User"
      WHERE "tenantId" IS NULL AND "disabledAt" IS NULL AND "deletedAt" IS NULL
    `,
  );
  if (usersWithoutTenantId > 0) {
    failures.push(`${usersWithoutTenantId} active user(s) have User.tenantId IS NULL (invisible under enforcement)`);
  }

  // ── 8. Composite tenant FK integrity (HARD failure) ────────────────────────
  //    The composite FKs (tenantId, childId) → Parent(tenantId, id) are added
  //    NOT VALID and validated in a SEPARATE migration (…180000). If that validation
  //    was ever skipped, cross-tenant / dangling child references sit undetected and
  //    silently break isolation. Re-derive every FK from the migration SQL (the exact
  //    definitions Postgres validates) and prove ZERO violating rows — independent of
  //    the DB's own constraint state. Matches Postgres MATCH SIMPLE: a row is skipped
  //    when EITHER FK column is NULL, so a null-tenant child is not double-flagged
  //    (section 5 already reports those).
  const fkDefs = readCompositeTenantFks();
  console.log(`Checking ${fkDefs.length} composite tenant FK(s) for cross-tenant / dangling refs…`);
  if (fkDefs.length < 120) {
    // The parser expects 130 composite FKs (verified against the migrations). A
    // shortfall means the regex missed definitions and would silently under-check —
    // surface it instead of passing a partial sweep.
    failures.push(
      `Composite-FK diagnostic parsed only ${fkDefs.length} FKs (expected 130) — parser/coverage is broken, not a clean bill of health`,
    );
  }
  for (const fk of fkDefs) {
    const rows = await basePrisma.$queryRawUnsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${fk.child}" c
         WHERE c."${fk.childCol}" IS NOT NULL AND c."tenantId" IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM "${fk.parent}" p
             WHERE p."tenantId" = c."tenantId" AND p."id" = c."${fk.childCol}"
           )`,
    );
    const n = Number(rows[0]?.count ?? 0);
    if (n > 0) {
      failures.push(
        `${n} ${fk.child}.${fk.childCol} row(s) reference a ${fk.parent} in another tenant or none (would FAIL the composite-FK VALIDATE)`,
      );
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const total = await basePrisma.tenant.count();
  const active = await basePrisma.tenant.count({ where: { active: true } });
  const activeUserCount = await rawCount(
    basePrisma.$queryRaw<CountRow[]>`
      SELECT COUNT(*)::bigint AS count FROM "User" WHERE "disabledAt" IS NULL AND "deletedAt" IS NULL
    `,
  );
  console.log(`\nProduction preflight — ${active}/${total} active tenants, ${activeUserCount} active users\n`);

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

  console.log(
    "All DB checks passed. NEXT: with enforcement still OFF, smoke-test founding-owner\n" +
      "login and open /platform/tenants, THEN enable TENANT_ENFORCEMENT=enforce.",
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
