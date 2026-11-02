import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

// Kristina (Breastfeeding Art, 2026-11-02) could not reset her password: the reset email ran with no tenant scope,
// and reading the mail settings refused with "No tenant scope established for AppSetting". These pin the cure.
const members: Record<string, string> = { kristina: "t_breastfeeding", ana: "t_withmail", sean: "tenant_denago_cpt" };
const smtpFor = new Set(["t_withmail", "tenant_denago_cpt"]);
const sent: { to: string; scope: string | null }[] = [];
let failNext = false;

const require = createRequire(import.meta.url);
const { currentTenantScope } = require("../src/lib/tenantScope") as typeof import("../src/lib/tenantScope");
const stubs: Record<string, unknown> = {
  "server-only": {},
  "./db": { basePrisma: { tenantMember: { findUnique: async ({ where }: { where: { userId: string } }) => (members[where.userId] ? { tenantId: members[where.userId] } : null) } } },
  "./email": {
    // Like the real one: the mail settings can only be read inside a workspace scope.
    isSmtpConfigured: async () => {
      const scope = currentTenantScope();
      if (!scope?.tenantId) throw new Error("No tenant scope established for AppSetting");
      return smtpFor.has(scope.tenantId);
    },
    sendEmail: async (m: { to: string }) => {
      const scope = currentTenantScope();
      if (!scope?.tenantId) throw new Error("No tenant scope established for AppSetting");
      if (failNext) { failNext = false; return { ok: false, error: "SMTP is not configured" }; }
      sent.push({ to: m.to, scope: scope.tenantId });
      return { ok: true };
    },
  },
  "./errorLog": { logError: async () => {} },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const { accountMailTenantId, sendAccountEmail, inAccountWorkspace } = require("../src/lib/accountEmail") as typeof import("../src/lib/accountEmail");

test("account mail goes as the person's own workspace when it has mail, else as the platform — never with no scope", async () => {
  assert.equal(currentTenantScope(), undefined, "called the way the login page calls it: no request scope");
  assert.equal(await accountMailTenantId("kristina"), "tenant_denago_cpt", "a workspace with no SMTP: the platform sends");
  assert.equal(await accountMailTenantId("ana"), "t_withmail", "a workspace with its own SMTP sends its own");
  assert.equal(await accountMailTenantId("sean"), "tenant_denago_cpt");
  assert.equal(await accountMailTenantId("nobody"), "tenant_denago_cpt");

  assert.equal(await sendAccountEmail("kristina", { to: "k@example.com", subject: "s", text: "t" }), true);
  assert.equal(await sendAccountEmail("ana", { to: "a@example.com", subject: "s", text: "t" }), true);
  assert.deepEqual(sent, [{ to: "k@example.com", scope: "tenant_denago_cpt" }, { to: "a@example.com", scope: "t_withmail" }]);
});

test("a failed send is reported, never thrown — the reset step still answers", async () => {
  failNext = true;
  assert.equal(await sendAccountEmail("kristina", { to: "k@example.com", subject: "s", text: "t" }), false);
});

test("the audit entry is written in the person's own workspace", async () => {
  assert.equal(await inAccountWorkspace("kristina", async () => currentTenantScope()?.tenantId), "t_breastfeeding");
});
