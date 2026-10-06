import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * quoteMirror run for real against fakes (no database). From the #781 review:
 * "is this signer staff?" must mean staff of THE REQUEST'S workspace. A customer
 * of Tenant A whose email is also a CRM user in Tenant B is still Tenant A's
 * customer — and a global lookup would also tell one workspace who belongs to
 * another.
 */

const T_A = "tenant_a";
const T_B = "tenant_b";
const state = {
  users: [] as { id: string; email: string }[],
  members: [] as { tenantId: string; userId: string }[],
  requestOpen: true,
  quoteWrites: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  memberLookups: [] as Record<string, unknown>[],
};

const tx = {
  $executeRaw: async () => 1,
  signatureRequest: { findFirst: async () => (state.requestOpen ? { id: "r1" } : null) },
  quote: {
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.quoteWrites.push(args);
      return { count: 1 };
    },
  },
};
const fakeBase = {
  $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  tenantMember: {
    findFirst: async ({ where }: { where: { tenantId: string; userId: { in: string[] } } }) => {
      state.memberLookups.push(where);
      return state.members.find((m) => m.tenantId === where.tenantId && where.userId.in.includes(m.userId)) ?? null;
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
const fromMirror = (parent: { filename?: string } | undefined) => (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/signing/quoteMirror.ts");
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (fromMirror(parent)) {
    switch (request) {
      case "@/lib/db": return { basePrisma: fakeBase };
      case "@/lib/errorLog": return { logError: async () => {} };
      case "@/lib/ciExact": return {
        // Exact, case-folded — the real helper's contract.
        ciExactIds: async (_target: string, value: string) => state.users.filter((u) => u.email.toLowerCase() === value.toLowerCase()).map((u) => u.id),
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { isCustomerSigner, mirrorQuoteSent, mirrorQuoteViewed } = require_("../src/lib/signing/quoteMirror.ts") as typeof import("../src/lib/signing/quoteMirror");

const ids = { tenantId: T_A, quoteId: "q1", requestId: "r1" };
const lisa = { role: "signer", email: "Lisa@Example.com" };

beforeEach(() => {
  state.users = [];
  state.members = [];
  state.requestOpen = true;
  state.quoteWrites = [];
  state.memberLookups = [];
});

test("same email is a CRM user in ANOTHER tenant → still this tenant's customer, and the quote is mirrored", async () => {
  state.users = [{ id: "u_b", email: "lisa@example.com" }];
  state.members = [{ tenantId: T_B, userId: "u_b" }];
  assert.equal(await isCustomerSigner(lisa, T_A), true);
  await mirrorQuoteSent(ids, lisa);
  await mirrorQuoteViewed(ids, lisa);
  assert.equal(state.quoteWrites.length, 2);
  assert.deepEqual(state.quoteWrites[0].data, { status: "sent" });
  assert.ok(state.quoteWrites[1].data.viewedAt instanceof Date);
  // Only ever asked about the request's own tenant.
  assert.ok(state.memberLookups.length > 0 && state.memberLookups.every((w) => w.tenantId === T_A));
});

test("same email is a member of THIS tenant → a staff signer, nothing mirrored", async () => {
  state.users = [{ id: "u_a", email: "lisa@example.com" }];
  state.members = [{ tenantId: T_A, userId: "u_a" }];
  assert.equal(await isCustomerSigner(lisa, T_A), false);
  await mirrorQuoteSent(ids, lisa);
  await mirrorQuoteViewed(ids, lisa);
  assert.equal(state.quoteWrites.length, 0);
});

test("a user in both tenants is staff here; an unknown email or a phone-only signer is a customer", async () => {
  state.users = [{ id: "u_x", email: "lisa@example.com" }];
  state.members = [{ tenantId: T_B, userId: "u_x" }, { tenantId: T_A, userId: "u_x" }];
  assert.equal(await isCustomerSigner(lisa, T_A), false);
  state.members = [];
  assert.equal(await isCustomerSigner({ role: "signer", email: "someone@else.co.za" }, T_A), true);
  assert.equal(await isCustomerSigner({ role: "signer", email: null }, T_A), true);
});

test("an approver or viewer is never the customer receiving the quote", async () => {
  assert.equal(await isCustomerSigner({ role: "approver", email: "x@y.z" }, T_A), false);
  assert.equal(await isCustomerSigner({ role: "viewer", email: "x@y.z" }, T_A), false);
  await mirrorQuoteSent(ids, { role: "approver", email: "x@y.z" });
  assert.equal(state.quoteWrites.length, 0);
});

test("a request closed in the meantime (voided mid-send) → the quote is left alone", async () => {
  state.requestOpen = false;
  await mirrorQuoteSent(ids, lisa);
  await mirrorQuoteViewed(ids, lisa);
  assert.equal(state.quoteWrites.length, 0);
});

test("every quote write names the request's tenant; no tenant → nothing at all", async () => {
  await mirrorQuoteSent(ids, lisa);
  assert.equal(state.quoteWrites[0].where.tenantId, T_A);
  state.quoteWrites = [];
  await mirrorQuoteSent({ ...ids, tenantId: null }, lisa);
  assert.equal(state.quoteWrites.length, 0);
});
