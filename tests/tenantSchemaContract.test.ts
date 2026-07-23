import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
// Empty: AppSetting — the last pending model — got its additive `tenantId` slice
// (migration 20260723120000). Every Prisma model is now either global or
// tenant-scoped, so the guard can be activated without a model failing closed on a
// missing column. New models must ship a tenantId or join GLOBAL_MODELS (adding
// back to PENDING is only a temporary, deliberately-visible escape hatch).
const PENDING = new Set<string>([]);

const schema = readFileSync(
  fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
  "utf8",
);

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
