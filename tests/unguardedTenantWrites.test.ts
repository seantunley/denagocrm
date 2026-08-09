import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A tenant-owned row written OUTSIDE the guard must stamp its own tenantId.
 *
 * `basePrisma` bypasses the db.ts extension by design, and it keeps bypassing it
 * after enforcement is switched on — so a create inside `basePrisma.$transaction`
 * is not "unstamped for now", it is unstamped for ever. That matters more than it
 * looks: statistics.ts deliberately attributes `tenantId IS NULL` rows to the
 * FOUNDING tenant (see tenantSql), because the pre-tenancy backfill left some
 * behind. A path that keeps minting NULL rows therefore does not lose a second
 * workspace's quotes and job cards — it files them under the first workspace.
 *
 * withTenantWrite's own contract says it plainly: "Every write inside MUST stamp
 * `tenantId` explicitly — bypass means the db.ts guard will not do it for you."
 *
 * Writes through the guarded `prisma` client are deliberately NOT covered here:
 * the extension stamps those under enforcement, which is the intended design.
 */

/** Models carrying a nullable tenantId — the ones a create can silently omit. */
function nullableTenantModels(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(path.join(root, "prisma")).filter((f) => f.endsWith(".prisma"))) {
    const src = read(`prisma/${file}`);
    for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      if (/^\s*tenantId\s+String\?/m.test(m[2])) {
        const name = m[1];
        out.add(name[0].toLowerCase() + name.slice(1));
      }
    }
  }
  return out;
}

function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

test("every unguarded write of a tenant-owned row stamps its tenant", () => {
  const models = nullableTenantModels();
  assert.ok(models.size > 0, "expected to find tenant-owned models in the schema");

  const offenders: string[] = [];
  for (const rel of sourceFiles()) {
    const code = read(rel);
    const lines = code.split("\n");
    for (const m of code.matchAll(/\btx\.(\w+)\.(create|createMany|upsert)\(/g)) {
      if (!models.has(m[1])) continue;
      const before = code.slice(0, m.index);
      // Which transaction opened this `tx`? Only the unguarded ones are our business.
      const unguarded = Math.max(before.lastIndexOf("withTenantWrite("), before.lastIndexOf("basePrisma.$transaction("));
      const guarded = before.lastIndexOf("prisma.$transaction(");
      if (unguarded < 0 || guarded > unguarded) continue;
      // The stamp lives in the data payload, which for createMany is inside a map.
      const payload = code.slice(m.index, m.index + 800);
      if (/\btenantId\b/.test(payload.split("});")[0] ?? payload)) continue;
      offenders.push(`${rel}:${before.split("\n").length} (${m[1]}.${m[2]})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These writes bypass the db.ts guard and never stamp tenantId, so their rows stay " +
      "tenantless for ever and statistics.ts files them under the founding tenant:\n  " +
      offenders.join("\n  "),
  );
});
