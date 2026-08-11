import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideActingScope, decideActingOwner } from "../src/lib/actingScopeRule";

/**
 * These tests exist because every OTHER test in this area establishes a tenant
 * scope first, which selects the enforced branch — the branch that already worked.
 * The defect lived in the branch that runs in production: enforcement dormant.
 *
 * So each case below pins `enforcing: false` deliberately. That is the condition
 * under which `withTenantWrite` stamped the founding tenant onto every actor's
 * rows, `resolveTenantMemberUser` skipped its membership join, and
 * `listTenantStaff` returned the whole platform.
 */

const A = "tenant_a";
const B = "tenant_b";
const FOUNDING = "tenant_denago_cpt";

/* ---------------------------------------------------------------- DORMANT */

test("dormant + a session in B acts as B, not the founding tenant", () => {
  const scope = decideActingScope({
    enforcing: false,
    enforcedScope: { mode: "global" }, // what currentScopeClass() says while dormant
    sessionTenantId: B,
  });
  assert.deepEqual(scope, { mode: "tenant", tenantId: B });
});

test("dormant + a session in B stamps B onto the row it creates", () => {
  const owner = decideActingOwner({
    enforcedTenantId: null, // writeTenantId() is null while dormant — the whole bug
    sessionTenantId: B,
    fallbackTenantId: FOUNDING,
  });
  assert.equal(owner, B, "a contact created by B's staff must belong to B");
  assert.notEqual(owner, FOUNDING);
});

test("dormant + NO session stays global — cron and webhooks are unchanged", () => {
  // Background paths deliberately rely on this. They have no actor to resolve,
  // and inventing one is the same defect with the sign flipped.
  const scope = decideActingScope({
    enforcing: false,
    enforcedScope: { mode: "global" },
    sessionTenantId: null,
  });
  assert.deepEqual(scope, { mode: "global" });
});

test("a blank or whitespace session claim is not a workspace", () => {
  for (const blank of ["", "   "]) {
    assert.deepEqual(
      decideActingScope({ enforcing: false, enforcedScope: { mode: "global" }, sessionTenantId: blank }),
      { mode: "global" },
      `"${blank}" must not be treated as a tenant id`,
    );
  }
  assert.equal(
    decideActingOwner({ enforcedTenantId: "  ", sessionTenantId: "   ", fallbackTenantId: FOUNDING }),
    FOUNDING,
  );
});

/* -------------------------------------------------------------- ENFORCING */

test("enforcement is authoritative — a session never widens it", () => {
  // Closed means a chokepoint was missed or propagation was lost. A session must
  // not rescue it; that would turn a fail-closed into a silent wrong answer.
  assert.deepEqual(
    decideActingScope({ enforcing: true, enforcedScope: { mode: "closed" }, sessionTenantId: B }),
    { mode: "closed" },
  );
  assert.deepEqual(
    decideActingScope({ enforcing: true, enforcedScope: { mode: "tenant", tenantId: A }, sessionTenantId: B }),
    { mode: "tenant", tenantId: A },
    "the enforced scope wins over a stale session claim",
  );
});

test("the enforced tenant outranks the session when stamping", () => {
  assert.equal(
    decideActingOwner({ enforcedTenantId: A, sessionTenantId: B, fallbackTenantId: FOUNDING }),
    A,
  );
});

/* ------------------------------------------------------- the wiring itself */

test("createContact writes through the acting helper, not the dormant one", () => {
  // The rule being right is worthless if the caller does not use it. This is the
  // exact site the two-tenant harness caught persisting tenant_denago_cpt
  // regardless of actor.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = readFileSync(path.join(root, "src/app/actions/contacts.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /withActingTenantWrite\(async \(tx, tenantId\) => \{/, "contact create must resolve the acting workspace");
  assert.doesNotMatch(code, /\bwithTenantWrite\(/, "no contact write may use the dormant-null helper");
  // Tags on an EXISTING contact belong to that contact, not to whoever edits it.
  assert.match(code, /const tenantId = contact\.tenantId \?\? actingTenantId;/);
});

test("the acting resolvers exist and classify with the acting scope", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const actor = readFileSync(path.join(root, "src/lib/tenantActor.ts"), "utf8");

  for (const fn of ["resolveActingTenantMemberUser", "listActingTenantStaff"]) {
    const start = actor.indexOf(`export async function ${fn}`);
    assert.ok(start > -1, `${fn} is missing`);
    const body = actor.slice(start, start + 400);
    assert.match(body, /await actingScopeClass\(\)/, `${fn} must classify with the acting scope`);
    assert.match(body, /TenantMember/, `${fn} must join TenantMember in tenant mode`);
  }

  // The originals must be LEFT ALONE — background and token paths rely on them.
  assert.match(actor, /const actorScope = currentScopeClass;/, "the background resolvers must keep their semantics");
});
