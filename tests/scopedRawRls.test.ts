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

  // withRlsScope takes the raw executor — and the transaction it batches on — as
  // parameters instead of reading them off a client. Reading `$executeRaw` off
  // the client is the bug above; reading `$transaction` off it would now reach
  // Layer 2c, which refuses the array form.
  assert.match(code, /async function withRlsScope\(transaction: any, execRaw: any, query: \(\) => any\)/);
  const start = code.indexOf("async function withRlsScope(");
  const body = code.slice(start, code.indexOf("\n}", start));
  assert.doesNotMatch(body, /\.\$executeRaw|\.\$transaction/, "must not read either off a patched client");
  assert.match(body, /execRaw`SELECT set_config\('app\.current_tenant'/);
  assert.match(body, /execRaw`SELECT set_config\('app\.bypass_rls'/);
  // The array transaction itself still belongs to the scoped client: both
  // promises have to come from the same client for Prisma to batch them.
  assert.match(body, /await transaction\(\[setGuc, query\(\)\]\)/);
});

test("the unpatched executor and transaction are captured BEFORE the patches overwrite them", () => {
  // Order is the whole fix. Captured after the loop, `ref.execRaw` would be the
  // wrapper and nothing would change; captured after Layer 2c, `ref.tx` would be
  // the refusal and every model operation in the app would throw.
  const code = read("src/lib/db.ts");
  const captureAt = code.indexOf("ref.execRaw = (scoped as any).$executeRaw.bind(scoped);");
  const patchAt = code.indexOf("for (const method of [\"$executeRaw\"");
  assert.ok(captureAt !== -1, "the unpatched executor must be captured");
  assert.ok(patchAt !== -1, "the raw patch loop must still exist");
  assert.ok(captureAt < patchAt, "capture must happen before the overwrite");
  const txCaptureAt = code.indexOf("ref.tx = (scoped as any).$transaction.bind(scoped);");
  const txPatchAt = code.indexOf("scopedFull.$transaction = ");
  assert.ok(txCaptureAt !== -1 && txPatchAt !== -1, "the native $transaction must be captured, and Layer 2c must still exist");
  assert.ok(txCaptureAt < txPatchAt, "…and captured before it is replaced");
  assert.equal((code.match(/withRlsScope\(ref\.tx, ref\.execRaw, \(\) => query\(scopedArgs\)\)/g) ?? []).length, 2, "both model-op paths batch on the native transaction");
});

/**
 * A TRANSACTION ON THE SCOPED CLIENT HAS TO BE ONE.
 *
 * `prisma.$transaction(async (tx) => …)` handed back a `tx` that was still the
 * scoped client, so every operation on it went through Layer 2 — whose batch
 * replaces the transaction it was called in — and every raw statement through
 * Layer 2b, which opens another. Each statement committed as it ran. The proof
 * is scripts/test-scoped-transactions.ts, against a real database; these pin the
 * shape that makes it true, for the places that cannot reach one.
 */
test("the callback form opens a real transaction on a sibling client that adds none of its own", () => {
  const code = shipped("src/lib/db.ts");
  const build = code.slice(code.indexOf("function buildClient("), code.indexOf("function buildBypassClient("));
  // Built from the soft-delete filters, NOT from `scoped`: an operation on its
  // `tx` must not reach Layer 2's batch, and its raw methods must be Prisma's own.
  const sibling = build.slice(build.indexOf("const inTransaction = alive.$extends("), build.indexOf("scopedFull.$transaction = "));
  assert.ok(sibling.length > 0, "the sibling client is gone — was Layer 2c restructured?");
  assert.match(sibling, /return query\(applyScopeArgs\(model, operation, args\)\);/, "the workspace scoping of the arguments is kept");
  assert.doesNotMatch(sibling, /withRlsScope|\$transaction\(/, "…and no transaction is opened per operation");
  // …and NOT from `guarded` either. That layer's `communication.create` hook opens
  // a conversation and recomputes it on ANOTHER connection, which then waits on
  // the transaction's own lock; an extension added earlier runs earlier, so it
  // cannot be pre-empted from here. The filters are shared, the hook is not.
  assert.match(build, /const alive = raw\.\$extends\(\{/);
  assert.match(build, /const guarded = alive\.\$extends\(\{\s*query: \{\s*communication: \{/, "the message hook is its own layer, on top of the filters");
  assert.match(sibling, /communication: \{\s*async create\(\) \{\s*throw messageInTransactionRefused\(\);/, "a timeline message is refused inside a transaction");
  assert.doesNotMatch(sibling, /attachToConversation|bumpConversation/);
  assert.match(
    build,
    /scopedFull\.\$transaction = \(arg: any, opts\?: any\) =>\s*typeof arg === "function"\s*\? scopedTransaction\(inTransaction, arg, opts\)\s*: Promise\.reject\(arrayTransactionRefused\(\)\);/,
  );

  const tx = code.slice(code.indexOf("async function scopedTransaction("), code.indexOf("function buildClient("));
  const setTenant = tx.indexOf("await tx.$executeRaw`SELECT set_config('app.current_tenant', ${scope.tenantId}, TRUE)`");
  const setBypass = tx.indexOf("await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', TRUE)`");
  const run = tx.indexOf("return fn(tx);");
  assert.ok(setTenant !== -1 && setBypass !== -1 && run !== -1);
  assert.ok(setTenant < run && setBypass < run, "the setting is the transaction's FIRST statement, on `tx` itself — before anything the caller runs");
  assert.match(tx, /const scope = tenantEnforcing\(\) \? currentTenantScope\(\) : null;/, "the same rule withRlsScope applies to a single operation");
});

test("the array form is refused on both clients", () => {
  const code = shipped("src/lib/db.ts");
  const bypass = code.slice(code.indexOf("function buildBypassClient("));
  assert.match(bypass, /full\.\$transaction = \(arg: any, opts: any\) => \{\s*if \(typeof arg === "function"\) \{[\s\S]*?\}\s*return Promise\.reject\(arrayTransactionRefused\(\)\);\s*\};/);
  // The two places that still build one are the mechanism itself: a setting and
  // ONE operation, batched on the native transaction.
  assert.equal((code.match(/await transaction\(\[setGuc, query\(\)\]\)/g) ?? []).length, 1);
  assert.equal((code.match(/await nat\.tx\(\[/g) ?? []).length, 1);
});

test("nothing in the app passes $transaction an array", () => {
  /*
   * An array is not a transaction on either client: each element commits on its
   * own, and a raw one is already running by the time the array is built. Two
   * callers showed what that costs — reordering a pipeline's stages and a
   * customer's reply on a support case both did their work and then threw.
   *
   * The guard that used to stand here looked for `$transaction([ … raw … ])` and
   * missed both: one was longer than its 600-character window, the other built
   * its array with `.map(`. So this reads the first argument, whatever it is.
   */
  const root = path.join(dir, "..", "src");
  const offenders: string[] = [];
  const walk = (p: string) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        if (full.endsWith(path.join("lib", "db.ts"))) continue; // the mechanism itself
        const src = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        for (const m of src.matchAll(/\$transaction\s*\(\s*([\s\S]{0,160})/g)) {
          const first = m[1];
          const isArray = /^\[/.test(first) || /^[\w.[\]!]+\s*\.\s*(?:map|flatMap|filter|concat)\s*\(/.test(first);
          if (isArray) offenders.push(`${path.relative(root, full).replace(/\\/g, "/")}: $transaction(${first.split("\n")[0].slice(0, 60)}`);
        }
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "pass a callback and run the statements on its `tx` — $transaction(async (tx) => { … })");
});
