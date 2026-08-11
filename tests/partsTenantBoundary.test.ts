import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/app/actions/parts.ts"), "utf8").replace(/\r\n/g, "\n");

function body(name: string, next?: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = next ? source.indexOf(`export async function ${next}`, start) : source.length;
  assert.ok(end > start, `${name} must have a body`);
  return source.slice(start, end);
}

test("part CRUD resolves the acting workspace while enforcement is dormant", () => {
  assert.match(source, /import \{ actingTenantId \} from "@\/lib\/actingTenant";/);
  for (const name of ["createPart", "updatePart", "adjustPartStock", "deletePart"]) {
    assert.match(body(name), /const tenantId = await actingTenantId\(\);/, `${name} must resolve its acting tenant`);
  }
});

test("a new part is born owned instead of tenantless", () => {
  const fn = body("createPart", "updatePart");
  assert.match(fn, /prisma\.part\.create\(\{[\s\S]*?data: \{[\s\S]*?tenantId,/);
});

test("part updates and deletes carry the tenant predicate on the destructive statement", () => {
  const update = body("updatePart", "adjustPartStock");
  assert.match(update, /part\.updateMany\(\{\s*where: \{ id, tenantId, deletedAt: null \}/);
  assert.match(update, /if \(updated\.count !== 1\) return;/);

  const remove = body("deletePart");
  assert.match(remove, /part\.updateMany\(\{\s*where: \{ id, tenantId, deletedAt: null \}/);
  assert.match(remove, /if \(deleted\.count !== 1\) return;/);
});

test("stock adjustment cannot increment a foreign part and reads back inside the same boundary", () => {
  const fn = body("adjustPartStock", "deletePart");
  assert.match(fn, /part\.updateMany\(\{\s*where: \{ id, tenantId, deletedAt: null \}/);
  assert.match(fn, /if \(updated\.count !== 1\) return null;/);
  assert.match(fn, /part\.findFirst\(\{\s*where: \{ id, tenantId, deletedAt: null \}/);
});

test("no Part mutation in this action file is still keyed by a bare id", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /part\.update\(\{\s*where: \{ id \}/);
  assert.doesNotMatch(code, /part\.delete\(\{\s*where: \{ id \}/);
});
