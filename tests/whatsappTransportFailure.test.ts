import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

// A fetch that THROWS (timeout, DNS, TLS, reset) must still leave a "NOT
// DELIVERED" line on the customer's timeline, and still reach the caller.

const failures: Array<{ to: string; error: string }> = [];
const successes: unknown[] = [];

const stubs: Record<string, unknown> = {
  "./db": { basePrisma: {}, prisma: {} },
  "./audit": { logAudit: async () => {} },
  "./storage": { shareableFileUrl: async (u: string) => u },
  "./push": { sendPushToAll: async () => {} },
  "./settings": {
    credentialOwnerTenantId: async () => null,
    resolveTenantCredential: async () => null,
    resolveIntegrationBundleForTenant: async () => ({
      tenantId: "t1",
      values: { WA_PHONE_NUMBER_ID: "123", WA_ACCESS_TOKEN: "stub" },
    }),
  },
  "./outboundMessageLog": {
    recordOutboundMessage: async (m: unknown) => void successes.push(m),
    recordOutboundFailure: async (m: { to: string }, _r: unknown, error: string) => void failures.push({ to: m.to, error }),
  },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const { sendWhatsAppText } = createRequire(import.meta.url)("../src/lib/whatsapp.ts") as typeof import("../src/lib/whatsapp");

const realFetch = globalThis.fetch;

test("a timed-out send is recorded as not delivered and still throws", async () => {
  failures.length = 0;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  try {
    await assert.rejects(sendWhatsAppText("27820000000", "hi", { contactId: "c1" }), { name: "TimeoutError" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(failures, [{ to: "27820000000", error: "Could not reach WhatsApp (timed out)" }]);
  assert.equal(successes.length, 0);
});

test("a connection error is recorded too", async () => {
  failures.length = 0;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(sendWhatsAppText("27820000000", "hi", { contactId: "c1" }), TypeError);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(failures, [{ to: "27820000000", error: "Could not reach WhatsApp (TypeError)" }]);
});

test("without a record nothing is logged, and the error still propagates", async () => {
  failures.length = 0;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(sendWhatsAppText("27820000000", "hi"), TypeError);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(failures.length, 0);
});
