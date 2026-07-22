import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { GLOBAL_MODELS } from "../src/lib/tenantGuard";

/**
 * Activation-safety contract: every Prisma model must be EITHER declared global
 * (in GLOBAL_MODELS) OR carry a `tenantId` field — otherwise, once enforcement is
 * on, the guard would scope a model that has no such column and every query would
 * fail at activation time. Reads the static DMMF (no DB connection).
 *
 * KNOWN PENDING: models intentionally not yet resolved. Each MUST be cleared
 * (given a tenantId, or moved to GLOBAL_MODELS) before enforcement is enabled.
 */
const PENDING = new Set<string>([
  // Decision 3: AppSetting becomes tenant-scoped — its additive tenantId slice
  // is a prerequisite step and lands before enforcement.
  "AppSetting",
]);

function hasTenantId(model: Prisma.DMMF.Model): boolean {
  return model.fields.some((f) => f.name === "tenantId");
}

test("every model is global, tenant-scoped, or explicitly pending", () => {
  const offenders: string[] = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    if (GLOBAL_MODELS.has(model.name)) continue;
    if (hasTenantId(model)) continue;
    if (PENDING.has(model.name)) continue;
    offenders.push(model.name);
  }
  assert.deepEqual(
    offenders,
    [],
    `Models neither global, tenant-scoped, nor pending — add tenantId, add to GLOBAL_MODELS, or (temporarily) to PENDING: ${offenders.join(", ")}`,
  );
});

test("no GLOBAL_MODELS entry is stale (each names a real model)", () => {
  const names = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));
  for (const g of GLOBAL_MODELS) {
    assert.ok(names.has(g), `GLOBAL_MODELS lists "${g}" but no such Prisma model exists`);
  }
});

test("no PENDING entry is stale (each is a real model still missing tenantId)", () => {
  const byName = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));
  for (const p of PENDING) {
    const model = byName.get(p);
    assert.ok(model, `PENDING lists "${p}" but no such Prisma model exists`);
    assert.equal(
      hasTenantId(model!),
      false,
      `PENDING lists "${p}" but it now HAS tenantId — remove it from PENDING`,
    );
  }
});
