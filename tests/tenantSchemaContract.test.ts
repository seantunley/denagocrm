import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";

/**
 * Activation-safety contract: every Prisma model must be EITHER declared global
 * (in GLOBAL_MODELS) OR carry a `tenantId` field — otherwise, once enforcement is
 * on, the guard would scope a model that has no such column and every query would
 * fail at activation time.
 *
 * Parses every `prisma/*.prisma` file directly — the source of truth. (The
 * generated client's runtime `Prisma.dmmf` proved unreliable here, returning
 * models absent from the current schema; the schema files never do.) No DB, no
 * client. `--schema ./prisma` (package.json) means Prisma treats the whole
 * directory as one multi-file schema — models live in schema.prisma AND
 * governance.prisma/journeys.prisma/testdrive.prisma/etc, so this MUST read
 * every file in the folder, not just schema.prisma, or models added in a
 * sibling file (like Team/TeamMember) silently escape the contract.
 *
 * KNOWN PENDING: models intentionally not yet resolved. Each MUST be cleared
 * (given a tenantId, or moved to GLOBAL_MODELS) before enforcement is enabled.
 */
// This test used to read ONLY prisma/schema.prisma, missing every model defined
// in a sibling multi-file-schema fragment (governance.prisma, journeys.prisma,
// etc — see the file-reading comment above). Fixing that just surfaced these 7
// PRE-EXISTING models that were never actually covered by the "every model is
// global or tenant-scoped" contract despite AppSetting once being called the
// "last pending model". None have a tenantId column today. Parked here
// (not silently classified) pending Sean's call on each:
//  - Role, Permission, RolePermission, UserRole — the RBAC tables backing
//    permissions.ts. Permission (a fixed key catalog) reads as global; Role/
//    RolePermission/UserRole plausibly want to be per-tenant (each tenant
//    defines its own roles) — a product decision, not inferred here.
//  - SalesPipeline — likely per-tenant (each dealer's own pipeline stages).
//  - ForecastSnapshot — likely per-tenant (derived from tenant-owned quotes).
//  - AuditEvent — append-only governance ledger (DB-level DELETE is blocked).
//    A prior tenant PR deliberately left its raw-SQL path untouched while
//    giving the separate AuditLog model a tenantId; unclear if that means
//    "AuditEvent is intentionally cross-tenant" (→ GLOBAL_MODELS) or "not
//    done yet" (→ needs a tenantId slice like AppSetting got) — needs Sean.
const PENDING = new Set<string>([
  "SalesPipeline",
  "Role",
  "Permission",
  "RolePermission",
  "UserRole",
  "ForecastSnapshot",
  "AuditEvent",
]);

const prismaDir = fileURLToPath(new URL("../prisma", import.meta.url));
const schema = readdirSync(prismaDir)
  .filter((name) => name.endsWith(".prisma"))
  .map((name) => readFileSync(join(prismaDir, name), "utf8"))
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
