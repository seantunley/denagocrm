import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Module from "node:module";

/*
 * Review of #1005: recipients were resolved through assistantUserFor, which also asks for DAX's permissions and the
 * Automation & AI module — so a colleague who can open the deal, but doesn't use DAX (or works where AI is off), was
 * never told they'd been mentioned. staffUserFor asks only "a member of this workspace?"; canOpenRecord decides the rest.
 */

const members = new Set(["u_sales_no_ai", "u_owner"]);
const users: Record<string, { id: string; name: string; email: string; role: string }> = {
  u_sales_no_ai: { id: "u_sales_no_ai", name: "Thabo", email: "t@x", role: "member" },
  u_owner: { id: "u_owner", name: "Sean", email: "s@x", role: "owner" },
  u_left: { id: "u_left", name: "Gone", email: "g@x", role: "member" },
};
let permissionsUnreadable = false;
const watches = [
  { type: "contact", id: "contact_shared", userId: "u_sales_no_ai" },
  { type: "contact", id: "contact_shared", userId: "u_owner" },
];
const sent: { userId: string; recordType: string; recordId: string; snippet: string | null }[] = [];

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "./db") {
    return {
      prisma: {},
      basePrisma: {
        user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null },
        recordWatch: { findMany: async ({ where }: { where: { recordType: string; recordId: string } }) => watches.filter((w) => w.type === where.recordType && w.id === where.recordId).map((w) => ({ userId: w.userId })) },
        staffNotification: {
          findFirst: async () => null,
          create: async ({ data }: { data: { userId: string; recordType: string; recordId: string; snippet: string | null } }) => { sent.push(data); return data; },
        },
        lead: { findFirst: async () => ({ title: "Golf cart for Lee", name: "Lee" }) },
        contact: { findFirst: async () => ({ firstName: "Lee", lastName: "Smith", company: null, isCompany: false }) },
      },
    };
  }
  // Who may open what: the deal is a colleague's; Thabo sees the shared customer but not that deal.
  if (request === "./permissions") {
    const leads: Record<string, string[]> = { u_owner: ["lead_private"], u_sales_no_ai: [] };
    const contacts: Record<string, string[]> = { u_owner: ["contact_shared"], u_sales_no_ai: ["contact_shared"] };
    return {
      canAccessLead: async (user: { id: string }, id: string) => (leads[user.id] ?? []).includes(id),
      canAccessContact: async (user: { id: string }, id: string) => (contacts[user.id] ?? []).includes(id),
      canAccessJobCard: async () => false,
      canAccessConversation: async () => false,
      getAccessibleLeadIds: async (user: { id: string }) => leads[user.id] ?? [],
      getAccessibleContactIds: async (user: { id: string }) => contacts[user.id] ?? [],
      getAccessibleJobCardIds: async () => [],
    };
  }
  // Only a sales permission — none of DAX's — and the AI module OFF: neither may matter.
  if (request === "./permissionQuery") return { RBAC_UNAVAILABLE: "__unavailable__", getUserPermissions: async () => new Set(permissionsUnreadable ? ["__unavailable__"] : ["contacts.view_owned"]) };
  if (request === "./modules/enabled") return { isModuleEnabled: async () => false, getEnabledModuleIds: async () => new Set() };
  if (request === "./tenantActor") return { resolveTenantMemberUser: async (id: string) => (members.has(id) ? { id } : null), listActingTenantStaff: async () => [] };
  if (request === "./push") return { sendPushToAll: async () => 0 };
  if (request === "./errorLog") return { logError: async () => {} };
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { staffUserFor, notifyWatchers } = require("../src/lib/collaboration") as typeof import("../src/lib/collaboration");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runInTenantScope } = require("../src/lib/tenantScope") as typeof import("../src/lib/tenantScope");

const inWorkspace = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: "tenant_a", system: false }, fn);

test("a colleague without DAX, in a workspace with AI off, can still be told", async () => {
  const user = await inWorkspace(() => staffUserFor("u_sales_no_ai"));
  assert.equal(user?.id, "u_sales_no_ai");
  assert.equal((await inWorkspace(() => staffUserFor("u_owner")))?.id, "u_owner");
});

test("but never someone outside the workspace, nor outside any workspace", async () => {
  assert.equal(await inWorkspace(() => staffUserFor("u_left")), null, "not a member");
  assert.equal(await runInTenantScope({ tenantId: null, system: true }, () => staffUserFor("u_owner")), null, "a system scope");
});

test("unreadable permissions throw rather than reading as 'may not see'", async () => {
  permissionsUnreadable = true;
  try {
    await assert.rejects(inWorkspace(() => staffUserFor("u_sales_no_ai")), /permissions unavailable/);
  } finally {
    permissionsUnreadable = false;
  }
});

test("a customer's watcher hears nothing from a deal they can't open (review of #1005)", async () => {
  for (const event of ["note", "reply", "stage"] as const) {
    sent.length = 0;
    // A private note on the colleague's deal, filed on the shared customer too.
    await inWorkspace(() => notifyWatchers("tenant_a", [{ type: "lead", id: "lead_private" }, { type: "contact", id: "contact_shared" }], event, { snippet: "Private: discount approved" }));
    assert.deepEqual(sent.map((s) => s.userId), ["u_owner"], `${event}: only the watcher who can open the deal`);
    assert.deepEqual([sent[0].recordType, sent[0].recordId], ["lead", "lead_private"], "it is about the deal, so the bell re-checks the deal");
  }
  // On the customer alone (no deal), the customer decides.
  sent.length = 0;
  await inWorkspace(() => notifyWatchers("tenant_a", [{ type: "lead", id: null }, { type: "contact", id: "contact_shared" }], "reply", { snippet: "Hi" }));
  assert.deepEqual(sent.map((s) => s.userId).sort(), ["u_owner", "u_sales_no_ai"]);
});

test("the notifier uses it, and still decides by what each person may open", () => {
  const lib = readFileSync("src/lib/collaboration.ts", "utf8");
  assert.match(lib, /const user = await staffUserFor\(userId\);[\s\S]{0,200}?if \(!user \|\| !\(await canOpenRecord\(user, ref\)\) \|\| \(notice\.watched && !\(await canOpenRecord\(user, notice\.watched\)\)\)\)/);
  assert.doesNotMatch(lib, /assistantUserFor\(|import[^\n]*assistantUser|ASSISTANT_PERMISSIONS|isModuleEnabled\("automation"\)/);
});
