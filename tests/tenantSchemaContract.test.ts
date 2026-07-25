import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";

/**
 * Activation-safety contract: every Prisma model must be EITHER declared global
 * (in GLOBAL_MODELS) OR carry a `tenantId` field — otherwise, once enforcement is
 * on, the guard would scope a model that has no such column and every query would
 * fail at activation time.
 *
 * Parses prisma/schema.prisma directly — the source of truth. (The generated
 * client's runtime `Prisma.dmmf` proved unreliable here, returning models absent
 * from the current schema; the schema file never does.) No DB, no client.
 *
 * KNOWN PENDING: models intentionally not yet resolved. Each MUST be cleared
 * (given a tenantId, or moved to GLOBAL_MODELS) before enforcement is enabled.
 */
// Until this test read EVERY prisma/*.prisma file (it previously read only
// schema.prisma), the models below sat in side-files (journeys.prisma,
// governance.prisma) and escaped the contract unnoticed — none carry `tenantId`
// and none are global. They are listed here as the deliberately-visible escape
// hatch so the gap is TRACKED, not silent. Each MUST be resolved before tenant
// enforcement is enabled, or its queries fail closed on a missing column:
//   - Journey* (journeys.prisma): PR #200 adds their `tenantId` slice — remove
//     from PENDING once that merges.
//   - governance.prisma RBAC/forecast models: SalesPipeline/Team/TeamMember/
//     UserRole/ForecastSnapshot/AuditEvent are tenant-owned and need a `tenantId`
//     slice; Role/Permission/RolePermission need a product decision on whether the
//     permission catalog is global or per-tenant (RBAC design — owner call).
const PENDING = new Set<string>([
  "Journey", "JourneyVersion", "JourneyEvent", "JourneyRun", "JourneyStepLog",
  "SalesPipeline", "Team", "TeamMember", "Role", "Permission",
  "RolePermission", "UserRole", "ForecastSnapshot", "AuditEvent",
]);

// Prisma is configured with `schema: "./prisma"` (folder mode), so it loads
// EVERY `prisma/*.prisma` file — not just schema.prisma. Read them all, or a
// model added to a side-file (journeys/governance/marketing/etc.) would escape
// this contract entirely and silently break the guard at enforcement time.
const prismaDir = fileURLToPath(new URL("../prisma", import.meta.url));
const schema = readdirSync(prismaDir)
  .filter((f) => f.endsWith(".prisma"))
  .sort()
  .map((f) => readFileSync(join(prismaDir, f), "utf8"))
  .join("\n");

/** Parse `model X { ... }` blocks (Prisma model bodies have no nested braces). */
function parseModels(src: string): Map<string, string> {
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) models.set(m[1], m[2]);
  return models;
}

/** A model owns a `tenantId` scalar field (a line `tenantId <Type>...`). */
function hasTenantId(body: string): boolean {
  return /^\s*tenantId\s+\w/m.test(body);
}

const MODELS = parseModels(schema);

test("schema parsed a plausible number of models", () => {
  // Guards against a broken parser silently passing the contract below.
  assert.ok(MODELS.size >= 50, `expected >= 50 models, parsed ${MODELS.size}`);
});

test("every model is global, tenant-scoped, or explicitly pending", () => {
  const offenders: string[] = [];
  for (const [name, body] of MODELS) {
    if (GLOBAL_MODELS.has(name)) continue;
    if (hasTenantId(body)) continue;
    if (PENDING.has(name)) continue;
    offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `Models neither global, tenant-scoped, nor pending — add tenantId, add to GLOBAL_MODELS, or (temporarily) to PENDING: ${offenders.join(", ")}`,
  );
});

test("no GLOBAL_MODELS entry is stale (each names a real model)", () => {
  for (const g of GLOBAL_MODELS) {
    assert.ok(MODELS.has(g), `GLOBAL_MODELS lists "${g}" but no such Prisma model exists`);
  }
});

test("no PENDING entry is stale (each is a real model still missing tenantId)", () => {
  for (const p of PENDING) {
    const body = MODELS.get(p);
    assert.ok(body !== undefined, `PENDING lists "${p}" but no such Prisma model exists`);
    assert.equal(hasTenantId(body!), false, `PENDING lists "${p}" but it now HAS tenantId — remove it from PENDING`);
  }
});
