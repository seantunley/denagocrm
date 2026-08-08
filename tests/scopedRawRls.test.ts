import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const RAW_METHODS = ["$executeRaw", "$queryRaw", "$executeRawUnsafe", "$queryRawUnsafe"] as const;

/**
 * A Prisma query extension intercepts MODEL operations. `$queryRaw` and friends
 * are not model operations, so the scoped client's two extensions — the tenant
 * guard and the `SET LOCAL` that makes FORCE RLS permit a row — skipped them
 * entirely.
 *
 * That is not a latent problem, it is a load-bearing one. FORCE ROW LEVEL
 * SECURITY has been live on 120 tables since 20260727130000_rls_enforce, and
 * every raw query issued through `prisma` went out with NO GUC set. They work
 * today only because the application role still carries `rolbypassrls`. Under
 * the restricted role the RLS work is explicitly heading for, each would have
 * returned zero rows.
 *
 * src/app/actions/portal.ts:58 already documents the trap for its own raw lookup
 * — "it works today only because the application role still has rolbypassrls,
 * and would return zero rows (breaking portal login outright) under the
 * restricted role the RLS work is heading for."
 *
 * The behavioural proof is scripts/test-rls-restricted.ts, which drives the real
 * client over a NOSUPERUSER NOBYPASSRLS connection with FORCE RLS actually
 * biting. It needs a live Postgres, so these are the structural guards that run
 * everywhere.
 */

test("the scoped client patches every raw method, not just model operations", () => {
  const code = shipped("src/lib/db.ts");
  const start = code.indexOf("function buildClient(");
  assert.notEqual(start, -1, "buildClient is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("function buildBypassClient(", start));

  for (const method of RAW_METHODS) {
    assert.ok(
      body.includes(`"${method}"`),
      `buildClient does not patch ${method} — raw queries would run with no GUC under FORCE RLS`,
    );
  }
  assert.match(body, /set_config\('app\.current_tenant'/, "a scoped raw query must pin the caller's tenant");
  assert.match(body, /set_config\('app\.bypass_rls', 'on'/, "…and bypass when there is no scope to pin");
});

test("a scoped raw query uses the caller's tenant, never bypass, when enforcing", () => {
  // The distinction that matters. Routing these through basePrisma — the obvious
  // "fix" — sets bypass, which would have turned fourteen tenant-scoped
  // user-facing reads into fourteen cross-tenant ones the moment isolation was
  // switched on. Worse than the bug.
  const code = shipped("src/lib/db.ts");
  const start = code.indexOf("const scopedFull = scoped as any;");
  assert.notEqual(start, -1, "the raw-method patch is gone");
  const patch = code.slice(start, code.indexOf("return scoped;", start));
  assert.match(patch, /tenantEnforcing\(\) \? currentTenantScope\(\) : null/, "same rule as withRlsScope");
  const tenantAt = patch.indexOf("app.current_tenant");
  const bypassAt = patch.indexOf("app.bypass_rls");
  assert.ok(tenantAt !== -1 && bypassAt !== -1, "both branches must exist");
  assert.ok(tenantAt < bypassAt, "the tenant branch must be tried FIRST — bypass is the fallback");
  assert.match(
    patch,
    /if \(scope\?\.tenantId\)/,
    "bypass only when there is genuinely no tenant to pin",
  );
});

test("the raw patch runs the query on the transaction, not the outer client", () => {
  // withRlsScope uses the ARRAY transaction for model ops because an interactive
  // one runs the op on a different pooled connection than `tx`. For raw methods
  // the opposite holds: the method is invoked ON `tx`, so it is by construction
  // on the same pinned connection as the SET LOCAL — and an array transaction
  // could not express it, because the raw promise would have to be created from
  // the outer client first. buildBypassClient makes the same choice.
  const code = shipped("src/lib/db.ts");
  const start = code.indexOf("const scopedFull = scoped as any;");
  const patch = code.slice(start, code.indexOf("return scoped;", start));
  assert.match(patch, /raw\.\$transaction\(async \(tx: any\) => \{/, "interactive transaction");
  assert.match(patch, /return tx\[method\]\(sql, \.\.\.values\);/, "the raw call runs ON tx");
  assert.match(patch, /await tx\.\$executeRaw`SELECT set_config/, "…and so does the SET LOCAL");
});

test("the bypass client keeps its own raw patch — the two are not merged", () => {
  // basePrisma must ALWAYS bypass: it is the trusted path for backups, trash,
  // cross-tenant reads and pre-auth lookups that have no scope to pin. If it ever
  // started honouring the ambient tenant, every one of those would fail closed.
  const code = shipped("src/lib/db.ts");
  const start = code.indexOf("function buildBypassClient(");
  const body = code.slice(start, code.indexOf("export const basePrisma", start));
  for (const method of RAW_METHODS) {
    assert.ok(body.includes(`"${method}"`), `buildBypassClient must still patch ${method}`);
  }
  assert.match(body, /set_config\('app\.bypass_rls', 'on', TRUE\)/);
  assert.doesNotMatch(body, /app\.current_tenant/, "the bypass client must never pin a tenant");
});

test("the restricted-role proof covers the scoped raw path in both modes", () => {
  // The structural tests above show the code is shaped right. This one shows the
  // BEHAVIOURAL proof exists — over a real NOSUPERUSER NOBYPASSRLS connection
  // with FORCE RLS biting, which is the only place the claim can actually be
  // tested. Without it, a future refactor could satisfy every regex here and
  // still emit no GUC.
  const proof = shipped("scripts/test-rls-restricted.ts");
  assert.match(proof, /scoped client RAW call, tenant A/, "isolation under tenant A");
  assert.match(proof, /scoped client RAW call, tenant B/, "…and under tenant B");
  assert.match(proof, /off-mode scoped RAW call/, "…and that today's behaviour is unchanged");
  assert.match(
    proof,
    /scoped\.\$queryRawUnsafe/,
    "the proof must drive the scoped client's RAW method, not a model op",
  );
});

test("every raw query on the scoped client is now covered by the patch", () => {
  // Inventory, so the count in the PR description cannot quietly go stale — and
  // so a reviewer can see that "fix it in the client" really did cover them all
  // rather than covering the ones somebody remembered.
  const files = [
    "src/app/(app)/leads/page.tsx",
    "src/app/(app)/stock/[id]/page.tsx",
    "src/app/(app)/stock/page.tsx",
    "src/app/actions/jobcards.ts",
    "src/lib/stockPlatform.ts",
    "src/lib/timelinePins.ts",
  ];
  let total = 0;
  for (const file of files) {
    const code = shipped(file);
    for (const match of code.matchAll(/(?<!base)prisma\.\$(queryRaw|executeRaw)/g)) {
      void match;
      total += 1;
    }
  }
  assert.ok(
    total > 0,
    "no scoped raw queries found — if they were all removed, this test and the patch can go too",
  );
  // Not an exact count: new ones are FINE now, which is the point of fixing it in
  // the client. The assertion is that they exist and therefore that the patch is
  // load-bearing, not decorative.
});

/**
 * THE BUG THIS FILE DID NOT CATCH.
 *
 * Layer 2b replaces `$executeRaw` on the exported client. Layer 2 — the model-op
 * path, which is every ordinary query in the app — read `$executeRaw` off that
 * same client to build the first element of an ARRAY transaction.
 *
 * An array transaction accepts only PrismaPromises; Prisma inspects each element
 * and throws "All elements of the array need to be Prisma Client promises" for
 * anything else. Layer 2b's replacement returns a plain Promise, because it
 * awaits an interactive transaction internally. So installing the raw patch made
 * EVERY model operation throw, on the first query of the first test — a total
 * outage, not a subtle regression.
 *
 * Every test above passed. They assert on source text, and the source they
 * assert on was correct; what was wrong was the interaction between two blocks
 * that never mention each other. `npm run test:integrity` caught it in CI on the
 * first run, which is the layer that could.
 *
 * These are the source assertions that would have caught it, kept narrow enough
 * to be about the mechanism rather than the formatting.
 */

test("the model-op path never uses the patched raw method", () => {
  const code = read("src/lib/db.ts");

  // withRlsScope takes the raw executor as a parameter instead of reading it off
  // the client it was handed. Reading it off `client` is the bug.
  assert.match(code, /async function withRlsScope\(client: any, execRaw: any, query: \(\) => any\)/);
  const start = code.indexOf("async function withRlsScope(");
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.doesNotMatch(body, /client\.\$executeRaw/, "must not read $executeRaw off the patched client");
  assert.match(body, /execRaw`SELECT set_config\('app\.current_tenant'/);
  assert.match(body, /execRaw`SELECT set_config\('app\.bypass_rls'/);
  // The array transaction itself still belongs to the scoped client: both
  // promises have to come from the same client for Prisma to batch them.
  assert.match(body, /await client\.\$transaction\(\[setGuc, query\(\)\]\)/);
});

test("the unpatched executor is captured BEFORE the patch overwrites it", () => {
  // Order is the whole fix. Captured after the loop, `ref.execRaw` would be the
  // wrapper and nothing would change.
  const code = read("src/lib/db.ts");
  const captureAt = code.indexOf("ref.execRaw = (scoped as any).$executeRaw.bind(scoped);");
  const patchAt = code.indexOf("for (const method of [\"$executeRaw\"");
  assert.ok(captureAt !== -1, "the unpatched executor must be captured");
  assert.ok(patchAt !== -1, "the raw patch loop must still exist");
  assert.ok(captureAt < patchAt, "capture must happen before the overwrite");
  assert.match(code, /withRlsScope\(ref\.c, ref\.execRaw, \(\) => query\(scopedArgs\)\)/);
});

test("no other array transaction is handed a raw promise", () => {
  // The same trap for any caller doing $transaction([prisma.$queryRaw`…`, …]).
  // There are none today; this fails if one is added, because it would break the
  // same way and the error message points at Prisma rather than at this patch.
  const root = path.join(dir, "..", "src");
  const offenders: string[] = [];
  const walk = (p: string) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const src = readFileSync(full, "utf8");
        if (full.endsWith(path.join("lib", "db.ts"))) continue; // the mechanism itself
        for (const m of src.matchAll(/\$transaction\(\[([\s\S]{0,600}?)\]\)/g)) {
          if (/\$(?:query|execute)Raw/.test(m[1])) offenders.push(path.relative(root, full));
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    "an array $transaction cannot contain a raw promise from the scoped client — use $transaction(async tx => …)",
  );
});
