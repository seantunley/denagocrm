import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideActingTenant } from "../src/lib/actingTenantRule";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * `writeTenantId() ?? DEFAULT_TENANT_ID` stamps the FOUNDING tenant onto every
 * user-originated write while enforcement is dormant — which is today — whatever
 * workspace the person was acting in.
 *
 * That is worse than leaving the column NULL. A NULL row is visibly unowned and
 * can be backfilled; a row stamped with a confident, wrong owner looks correct to
 * every later query, appears in the wrong workspace, and vanishes from the one
 * that created it the moment enforcement flips on.
 *
 * The previous scanner could not catch this: it checked the payload contained the
 * token `tenantId`, so `tenantId: totallyWrongTenant` passed just as happily.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant_second_workspace";

test("DORMANT enforcement, acting in workspace B: the row belongs to B", () => {
  // The defect, stated as the property it broke.
  assert.equal(decideActingTenant({ enforcedTenantId: null, sessionTenantId: B }), B);
  assert.notEqual(decideActingTenant({ enforcedTenantId: null, sessionTenantId: B }), A);
});

test("an enforced scope still wins, and a claimless session still behaves as before", () => {
  // Under enforcement the guard's scope is authoritative; the session claim is
  // the rollout-window fallback, not an override.
  assert.equal(decideActingTenant({ enforcedTenantId: A, sessionTenantId: B }), A);
  assert.equal(decideActingTenant({ enforcedTenantId: B, sessionTenantId: A }), B);
  // A session minted before the tid claim existed resolves to null — byte-for-byte
  // today's single-tenant behaviour.
  assert.equal(decideActingTenant({ enforcedTenantId: null, sessionTenantId: null }), A);
});

test("the rule is the one the resolver actually applies", () => {
  const resolver = src("src/lib/actingTenant.ts");
  assert.match(resolver, /enforcedTenantId: writeTenantId\(\)/);
  assert.match(resolver, /sessionTenantId: await getActiveTenantId\(\)/);
  // The resolver must not re-implement the fallback itself. Strip comments first:
  // the note explaining WHY that expression is wrong quotes the expression.
  const code = resolver.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\?\? DEFAULT_TENANT_ID/);
});

/** Every Server Action file — these run with a staff session behind them. */
function staffActionFiles(): string[] {
  const dir = "src/app/actions";
  return readdirSync(path.join(root, dir))
    .filter((name) => /\.ts$/.test(name))
    .map((name) => `${dir}/${name}`);
}

test("no Server Action stamps a write with the dormant founding-tenant fallback", () => {
  // The class, not the instances: a new action written the obvious way fails here
  // rather than quietly filing rows against tenant A.
  const offenders: string[] = [];
  for (const file of staffActionFiles()) {
    const code = src(file);
    for (const hit of code.match(/writeTenantId\(\) \?\? DEFAULT_TENANT_ID/g) ?? []) {
      offenders.push(`${file}: ${hit}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "user-originated writes must resolve the acting workspace, not fall back to the founding tenant:\n  " +
      offenders.join("\n  "),
  );
});

test("the actions that were stamping wrongly now resolve the acting workspace", () => {
  for (const file of [
    "src/app/actions/quotes.ts",
    "src/app/actions/jobcards.ts",
    "src/app/actions/helpdesk.ts",
    "src/app/actions/privacy.ts",
    "src/app/actions/recordSigning.ts",
  ]) {
    const code = src(file);
    assert.match(code, /import \{ actingTenantId \} from "@\/lib\/actingTenant";/, `${file} does not resolve an owner`);
    assert.match(code, /actingTenantId\(\)/, `${file} does not use it`);
  }
});

test("a portal write takes its owner from the Contact, not from a staff session", () => {
  // The portal is a CUSTOMER session. getActiveTenantId() is null there, so the
  // acting-workspace resolver would fall back to the founding tenant and file one
  // tenant's customer's consent against another.
  const portal = src("src/app/actions/portal.ts");
  assert.match(portal, /basePrisma\.contact\.findUnique\(\{[\s\S]{0,120}select: \{ tenantId: true \}/);
  assert.match(portal, /currentTenantScope\(\)\?\.tenantId \?\? owner\?\.tenantId \?\? null/);
  assert.doesNotMatch(portal, /actingTenantId\(\)/, "a customer has no acting workspace");
});

test("background work is deliberately excluded, and says so", () => {
  // Cron, webhooks and queue drains have no session. Pointing them at
  // getActiveTenantId() would be the same bug in the other direction.
  const resolver = src("src/lib/actingTenant.ts");
  assert.match(resolver, /NOT for background work/);
  for (const file of ["src/lib/journeyTenant.ts", "src/lib/repairs.ts"]) {
    assert.doesNotMatch(src(file), /actingTenantId/, `${file} runs without a session`);
  }
});
