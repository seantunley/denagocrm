import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";

/*
 * Review of #1010: "whole workspace" was taken to mean the id helpers returned null — but they return every id even
 * for full access, so the trend never switched on for owners and managers. This runs loadDataQuality with the REAL
 * permission checks (lib/permissions.ts) over a stubbed permission table and database: a manager granted
 * contacts.view_all and leads.view_all gets the snapshot and the trend, without reading every id; a salesperson
 * with only their own records doesn't.
 */

const grants: Record<string, string[]> = {
  u_manager: ["contacts.view_all", "leads.view_all"],
  u_sales: ["contacts.view_owned", "leads.view_owned"],
};
const snapshots: { tenantId: string; day: string; score: number }[] = [];
const idReads: string[] = [];

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") {
    const contact = { findMany: async (args: { select?: { id?: boolean; firstName?: boolean } }) => {
      // The id helpers' read (select: { id }) is what full access must no longer do.
      if (args.select && !args.select.firstName) { idReads.push("contact"); return [{ id: "c1" }]; }
      return [{ id: "c1", firstName: "Lee", lastName: null, company: null, isCompany: false, email: "lee@x.co", phone: "0825551234", whatsapp: null, ownerId: "u1", source: "web" }];
    } };
    const lead = { findMany: async (args: { select?: { title?: boolean } }) => {
      if (args.select && !args.select.title) { idReads.push("lead"); return [{ id: "l1" }]; }
      return [{ id: "l1", title: "Cart", name: "Lee", status: "open", contactId: "c1", valueCents: 100, assignedToId: "u1", email: null, phone: null, contact: { email: "lee@x.co", phone: "0825551234" } }];
    } };
    return {
      prisma: { contact, lead },
      basePrisma: {
        contact, lead,
        dataQualitySnapshot: {
          create: async ({ data }: { data: { tenantId: string; day: string; score: number } }) => { snapshots.push(data); return data; },
          findMany: async () => snapshots.map((s) => ({ day: s.day, score: s.score })),
        },
      },
    };
  }
  if (request === "./actingTenant") return { actingTenantId: async () => "tenant_a" };
  if (request === "./contactMatch") return { emailKey: (e: string | null) => (e ? e.trim().toLowerCase() : null) };
  // The permission TABLE is stubbed; the rules reading it (hasPermission) are the real ones.
  if (request === "./permissionQuery") {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, getUserPermissions: async (userId: string) => new Set([String(real.RBAC_INITIALIZED), ...(grants[userId] ?? [])]) };
  }
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadDataQuality } = require("../src/lib/dataQuality") as typeof import("../src/lib/dataQuality");

test("a manager with full access gets the workspace snapshot and trend, without reading every id", async () => {
  snapshots.length = 0;
  idReads.length = 0;
  const q = await loadDataQuality({ id: "u_manager", name: "M", email: "m@x", role: "member" });
  assert.equal(q.wholeWorkspace, true);
  assert.equal(snapshots.length, 1, "today's snapshot was recorded");
  assert.equal(q.trend.length, 1);
  assert.deepEqual(idReads, [], "full access reads no id lists");
});

test("a salesperson with only their own records gets no workspace snapshot", async () => {
  snapshots.length = 0;
  const q = await loadDataQuality({ id: "u_sales", name: "S", email: "s@x", role: "member" });
  assert.equal(q.wholeWorkspace, false);
  assert.equal(snapshots.length, 0);
  assert.deepEqual(q.trend, []);
});
