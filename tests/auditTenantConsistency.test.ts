import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

/**
 * The audit row must never claim a tenant its subject does not have.
 *
 * PRODUCTION, 2026-08-07. Creating a lead for a new person failed three times in
 * four minutes with:
 *
 *     Foreign key constraint violated on the constraint:
 *     `AuditLog_tenantId_contactId_fkey`
 *
 * AuditLog's foreign keys are COMPOSITE — (tenantId, contactId) → Contact and
 * (tenantId, leadId) → Lead — so the audit row's tenant has to equal the tenant
 * of whatever it points at. Tenant stamping is dormant, so the freshly created
 * contact was written with tenantId NULL while getActiveTenantId() returned
 * `tenant_denago_cpt`. The pair matched no Contact row.
 *
 * The contact and the lead were already committed by then, because the audit
 * write happens after them and logAuditStrict throws. So each "failure" left a
 * real lead behind and the retry made another: two duplicate leads for one
 * person. Existing contacts were unaffected — a migration had backfilled their
 * tenantId — which is why this only appeared when someone created a NEW contact.
 *
 * These tests drive the real writeAudit against a fake database, because the
 * mismatch is a runtime relationship between three rows and no source assertion
 * can see it.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** What the fake database holds, and what the audit write attempted. */
const db = {
  leads: new Map<string, { tenantId: string | null }>(),
  contacts: new Map<string, { tenantId: string | null }>(),
  written: [] as Array<{ tenantId: string | null; contactId: string | null; leadId: string | null }>,
};

/** The composite foreign keys, enforced exactly as PostgreSQL enforces them. */
function enforceCompositeForeignKeys(row: { tenantId: string | null; contactId: string | null; leadId: string | null }) {
  // MATCH SIMPLE: a composite key with any NULL column is not checked at all.
  if (row.tenantId !== null && row.contactId !== null) {
    const contact = db.contacts.get(row.contactId);
    if (!contact || contact.tenantId !== row.tenantId) {
      throw new Error("Foreign key constraint violated on the constraint: `AuditLog_tenantId_contactId_fkey`");
    }
  }
  if (row.tenantId !== null && row.leadId !== null) {
    const lead = db.leads.get(row.leadId);
    if (!lead || lead.tenantId !== row.tenantId) {
      throw new Error("Foreign key constraint violated on the constraint: `AuditLog_tenantId_leadId_fkey`");
    }
  }
}

const auditLog = {
  create: async ({ data }: { data: { tenantId: string | null; contactId: string | null; leadId: string | null } }) => {
    enforceCompositeForeignKeys(data);
    db.written.push({ tenantId: data.tenantId, contactId: data.contactId, leadId: data.leadId });
    return data;
  },
};

const client = {
  auditLog,
  lead: { findUnique: async ({ where }: { where: { id: string } }) => db.leads.get(where.id) ?? null },
  contact: { findUnique: async ({ where }: { where: { id: string } }) => db.contacts.get(where.id) ?? null },
  $executeRaw: async () => 1,
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ auditLog, $executeRaw: async () => 1 }),
};

/** The acting tenant, as getActiveTenantId() would report it. */
let activeTenant: string | null = "tenant_denago_cpt";

const stubs: Record<string, unknown> = {
  "server-only": {},
  "next/headers": { headers: async () => new Map() },
  "./db": { basePrisma: client, prisma: client },
  "./tenantScope": { currentTenantScope: () => ({ tenantId: activeTenant, system: false }) },
  "./auth": {
    getCurrentUser: async () => ({ id: "u_1", name: "Sean" }),
    getActiveTenantId: async () => activeTenant,
  },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  // `actingTenantId` reaches ./auth through a DYNAMIC import, which arrives here
  // without the requesting filename — so anchoring every stub on the parent
  // silently missed it and the real module threw into the catch, returning null.
  // The relative specifiers below only exist inside src/lib, so matching them
  // unanchored is safe.
  if (request in stubs && (!parent?.filename || parent.filename.endsWith("audit.ts"))) {
    return stubs[request];
  }
  if (request === "server-only" || request === "client-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const audit = createRequire(import.meta.url)("../src/lib/audit.ts") as typeof import("../src/lib/audit");

const user = { id: "u_1", name: "Sean", email: "sean@example.invalid", role: "owner" } as Parameters<
  typeof audit.logAuditStrict
>[0]["user"];

test("an unstamped new contact does not break the audit that describes it", async () => {
  // EXACTLY THE PRODUCTION SHAPE: stamping is dormant, so the contact created a
  // moment ago has no tenant, while the acting tenant is real.
  db.written.length = 0;
  db.contacts.set("c_new", { tenantId: null });
  db.leads.set("l_new", { tenantId: null });

  await audit.logAuditStrict({
    action: "lead.created",
    summary: "Created lead",
    leadId: "l_new",
    contactId: "c_new",
    user,
  });

  assert.equal(db.written.length, 1, "the audit must be written, not thrown away");
  // NULL, matching what it points at — which is the only legal value here.
  assert.equal(db.written[0].tenantId, null);
});

test("a backfilled contact keeps its tenant on the audit row", async () => {
  // The case that always worked, and must go on working: the referenced records
  // carry the acting tenant, so the audit row does too.
  db.written.length = 0;
  db.contacts.set("c_old", { tenantId: "tenant_denago_cpt" });
  db.leads.set("l_old", { tenantId: "tenant_denago_cpt" });

  await audit.logAuditStrict({
    action: "lead.updated",
    summary: "Updated lead",
    leadId: "l_old",
    contactId: "c_old",
    user,
  });

  assert.equal(db.written.length, 1);
  assert.equal(db.written[0].tenantId, "tenant_denago_cpt", "tenant attribution must be kept where it is legal");
});

test("a half-stamped pair is written without a tenant rather than failing", async () => {
  // A lead that was backfilled and a contact that was not cannot both be
  // satisfied by one tenant value. Losing attribution on this row beats losing
  // the audit — and beats telling the operator their save failed when it did not.
  db.written.length = 0;
  db.contacts.set("c_mixed", { tenantId: null });
  db.leads.set("l_mixed", { tenantId: "tenant_denago_cpt" });

  await audit.logAuditStrict({
    action: "lead.deleted",
    summary: "Deleted lead",
    leadId: "l_mixed",
    contactId: "c_mixed",
    user,
  });

  assert.equal(db.written.length, 1);
  assert.equal(db.written[0].tenantId, null);
});

test("an audit with no subject still records the acting tenant", async () => {
  // Nothing is referenced, so nothing constrains it and attribution is free —
  // the fix must not throw tenant attribution away wholesale.
  //
  // Attributed to a scope rather than a signed-in user on purpose: the
  // staff-identity branch reaches ./auth through a dynamic import, which stays
  // ESM under tsx and so cannot be swapped by the CJS loader hook. That branch
  // is untouched by this change; what is being tested here is that an entry with
  // no lead or contact keeps taking the acting tenant.
  db.written.length = 0;
  await audit.logAuditStrict({
    action: "settings.changed",
    summary: "Changed a setting",
    userName: "Website",
  });

  assert.equal(db.written.length, 1);
  assert.equal(db.written[0].tenantId, "tenant_denago_cpt");
});

test("the guard is what prevents the failure, not the fake", async () => {
  // Proof the harness models the constraint: writing the ACTING tenant against
  // an unstamped contact — what the code did before — is refused.
  db.contacts.set("c_probe", { tenantId: null });
  assert.throws(
    () => enforceCompositeForeignKeys({ tenantId: "tenant_denago_cpt", contactId: "c_probe", leadId: null }),
    /AuditLog_tenantId_contactId_fkey/,
  );
});
