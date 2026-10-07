import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * The two quote watches run for real against fakes (no database). From the #785
 * review: "Anna opened Q-1042" and "opened but unsigned for 48 hours" must come
 * from the CUSTOMER opening it — #781's definition, shared: a signer who isn't
 * staff of the watch's own workspace. A colleague countersigning, an approver
 * or a viewer never counts; a user of ANOTHER workspace is still this one's
 * customer.
 */

const T_A = "tenant_a";
const T_B = "tenant_b";
const HOUR = 3_600_000;
const NOW = new Date("2026-10-07T10:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

type Recipient = { role: string; email: string | null; viewedAt: Date | null };
const state = {
  users: [] as { id: string; email: string }[],
  members: [] as { tenantId: string; userId: string }[],
  requests: [] as { tenantId: string; quoteId: string; status: string; recipients: Recipient[] }[],
  memberLookups: [] as Record<string, unknown>[],
};

const QUOTE = { id: "q1", number: 1042, viewedAt: null, lead: { name: "Anna Jacobs" }, contact: null };

type Where = Record<string, unknown> & {
  tenantId?: string;
  status?: { in?: string[]; notIn?: string[] };
  quoteId?: { in?: string[] } | string;
  recipients?: { some: { role: string; viewedAt: { lte?: Date; not?: null } } };
};
const statusOk = (s: string, f: Where["status"]) => (!f ? true : f.in ? f.in.includes(s) : f.notIn ? !f.notIn.includes(s) : true);
const quoteOk = (q: string, f: Where["quoteId"]) => (typeof f === "string" ? q === f : f?.in ? f.in.includes(q) : true);
const someSigner = (rs: Recipient[], f: Where["recipients"]) =>
  !f || rs.some((r) => r.role === f.some.role && r.viewedAt && (!f.some.viewedAt.lte || r.viewedAt <= f.some.viewedAt.lte));

const fakePrisma = {
  signatureRequest: {
    findMany: async ({ where }: { where: Where }) =>
      state.requests.filter((r) => r.tenantId === where.tenantId && statusOk(r.status, where.status) && quoteOk(r.quoteId, where.quoteId) && someSigner(r.recipients, where.recipients)),
  },
  quote: {
    findFirst: async () => QUOTE,
    // The unsigned check's quote read: q1 qualifies only when the hub says it was opened in time.
    findMany: async ({ where }: { where: { AND?: { OR: { id?: { in: string[] } }[] }[] } }) => {
      const hubIds = where.AND?.[0]?.OR.find((x) => x.id)?.id?.in ?? [];
      return hubIds.includes("q1") ? [QUOTE] : [];
    },
  },
};
const fakeBase = {
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
const from = (parent: { filename?: string } | undefined, file: string) => (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);
const noop = async () => {};
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (from(parent, "src/lib/assistantWatch.ts")) {
    switch (request) {
      case "./db": return { prisma: fakePrisma };
      case "./errorLog": return { logError: noop };
      case "./audit": return { logAudit: noop };
      case "./assistantUser": return { assistantUserFor: noop };
      case "./tenantScope": return { currentTenantScope: () => null };
      case "./push": return { sendPushToAll: noop };
      case "./settings": return { getSetting: async () => null };
      case "./assistantSoul": return { ASSISTANT_PROFILE_KEY: "x", parseProfile: () => ({ name: "DAX" }) };
      case "./permissions": return {
        canAccessQuote: async () => true, canAccessLead: async () => true,
        getAccessibleQuoteIds: async () => null, getAccessibleLeadIds: async () => null, hasAnyPermission: async () => true,
      };
      case "./testDriveAccess": return { accessibleTestDriveWhere: async () => ({}) };
      case "./customerContact": return { contactActivityWhere: {}, contactCommunicationWhere: {}, latestContactAt: () => null };
      case "./modules/enabled": return { isModuleEnabled: async () => true };
      case "./tenantWrite": return { ownedWriteTenantId: () => T_A };
    }
  }
  if (from(parent, "src/lib/signing/quoteMirror.ts")) {
    switch (request) {
      case "@/lib/db": return { basePrisma: fakeBase };
      case "@/lib/errorLog": return { logError: noop };
      case "@/lib/ciExact": return {
        ciExactIds: async (_t: string, value: string) => state.users.filter((u) => u.email.toLowerCase() === value.toLowerCase()).map((u) => u.id),
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { checkQuoteViewed, checkQuoteUnsigned } = require_("../src/lib/assistantWatch.ts") as typeof import("../src/lib/assistantWatch");

const user = { id: "u_me", name: "Sean", email: "sean@example.com", role: "owner" };
const watch = (kind: string) => ({
  id: "w1", tenantId: T_A, userId: "u_me", kind, leadId: null, quoteId: "q1", product: null,
  thresholdHours: kind === "quote_unsigned" ? 48 : null, thresholdDays: null, label: "", fired: null, lastCheckedAt: null,
});
const viewed = () => checkQuoteViewed(user, T_A, watch("quote_viewed"));
const unsigned = () => checkQuoteUnsigned(user, T_A, watch("quote_unsigned"), NOW);
const request = (...recipients: Recipient[]) => state.requests.push({ tenantId: T_A, quoteId: "q1", status: "in_progress", recipients });

const staffSigner = (viewedAt: Date | null): Recipient => ({ role: "signer", email: "Donovan@Denago.co.za", viewedAt });
const customer = (viewedAt: Date | null): Recipient => ({ role: "signer", email: "anna@example.com", viewedAt });

beforeEach(() => {
  // Donovan is staff of THIS workspace.
  state.users = [{ id: "u_don", email: "donovan@denago.co.za" }];
  state.members = [{ tenantId: T_A, userId: "u_don" }];
  state.requests = [];
  state.memberLookups = [];
});

test("1. a staff countersigner opens it, the customer hasn't → neither watch fires", async () => {
  request(staffSigner(ago(72)), customer(null));
  assert.deepEqual(await viewed(), [], "no “Anna opened Q-1042” from Donovan opening it");
  assert.deepEqual(await unsigned(), [], "no 48-hour clock started by a staff view");
});

test("2. the customer opens it → both behave normally", async () => {
  request(staffSigner(ago(80)), customer(ago(50)));
  const hit = await viewed();
  assert.ok(Array.isArray(hit) && hit.length === 1 && hit[0].ref === "Q-1042");
  const late = await unsigned();
  assert.ok(Array.isArray(late) && late.length === 1, "opened 50h ago and unsigned → past 48h");
  // Opened by the customer only 10 hours ago: the clock runs from THEIR view, not Donovan's.
  state.requests = [];
  request(staffSigner(ago(80)), customer(ago(10)));
  assert.deepEqual(await unsigned(), [], "not yet 48h since the customer opened it");
});

test("3. the customer's email is a CRM user in ANOTHER workspace → still this workspace's customer", async () => {
  state.users.push({ id: "u_anna_b", email: "anna@example.com" });
  state.members.push({ tenantId: T_B, userId: "u_anna_b" });
  request(customer(ago(60)));
  assert.equal((await viewed() as unknown[]).length, 1);
  assert.equal((await unsigned() as unknown[]).length, 1);
  // And only ever asked about the watch's own workspace.
  assert.ok(state.memberLookups.length > 0 && state.memberLookups.every((w) => w.tenantId === T_A));
});

test("4. an approver or a viewer opening it never counts", async () => {
  request({ role: "approver", email: "boss@client.com", viewedAt: ago(70) }, { role: "viewer", email: "cc@client.com", viewedAt: ago(70) }, customer(null));
  assert.deepEqual(await viewed(), []);
  assert.deepEqual(await unsigned(), []);
});
