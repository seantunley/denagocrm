import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The replacement cookie must carry the version ITS OWN transaction wrote.
 *
 * Re-reading the row afterwards looks harmless and undoes somebody else's
 * revocation:
 *
 *   1. this action commits, bumping sessionVersion to 5;
 *   2. another administrator revokes all sessions, bumping it to 6 — every live
 *      cookie, including this one, is now dead;
 *   3. this action reads "whatever it is now", gets 6, and mints a fresh valid
 *      cookie at 6.
 *
 * Step 3 hands back access that step 2 deliberately removed. A source assertion
 * cannot tell a pinned version from a re-read one, so this runs the real action
 * against a fake database that performs the concurrent revocation at exactly the
 * moment the transaction commits, and checks which version reaches the cookie.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** The version the acting admin's replacement cookie was issued at. */
type Issued = { sessionVersion: number } | null;
let issued: Issued = null;
/** What the row says, mutated by the fake transaction and by the "other admin". */
const row = { id: "pa_1", name: "Root", email: "root@example.invalid", sessionVersion: 4, disabledAt: null as Date | null };

const tx = {
  platformAdmin: {
    update: async () => {
      row.sessionVersion += 1; // 4 → 5, this transaction's write
      return { ...row };
    },
    updateMany: async () => {
      row.sessionVersion += 1;
      return { count: 1 };
    },
    findUnique: async () => ({ ...row }),
  },
};

const basePrisma = {
  platformAdmin: {
    findUnique: async () => ({
      ...row,
      totpSecret: "encrypted",
      totpEnabledAt: new Date("2026-01-01T00:00:00Z"),
      totpPendingSecret: null,
    }),
    update: async () => ({ ...row }),
  },
  $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => {
    const result = await fn(tx);
    // THE RACE, at the only instant it matters: another administrator revokes
    // every session the moment this transaction commits.
    row.sessionVersion += 1; // 5 → 6
    return result;
  },
};

const stubs: Record<string, unknown> = {
  "server-only": {},
  qrcode: { default: { toDataURL: async () => "data:image/png;base64,x" } },
  "next/cache": { revalidatePath: () => {} },
  "@/lib/db": { basePrisma },
  "@/lib/audit": { logAuditStrict: async () => {} },
  "@/lib/settings": { encryptValue: (v: string) => v, decryptValue: (v: string) => v },
  "@/lib/platformIdentity": { PLATFORM_NAME: "Test Platform" },
  "@/lib/backupCodes": { hashBackupCode: (c: string) => `h:${c}` },
  "@/lib/totp": {
    verifyTotp: () => true,
    generateTotpSecret: () => "SECRET",
    generateBackupCodes: () => ["aaaa-bbbb"],
    totpKeyUri: () => "otpauth://x",
  },
  "@/lib/platformAuth": {
    requirePlatformAdminAction: async () => ({ id: row.id, name: row.name, email: row.email }),
    createPlatformSessionCookie: async (identity: { sessionVersion: number }) => {
      issued = { sessionVersion: identity.sessionVersion };
    },
  },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const actions = createRequire(import.meta.url)(
  "../src/app/actions/platformSecurity.ts",
) as typeof import("../src/app/actions/platformSecurity");

test("a revocation landing after the write is NOT undone by the replacement cookie", async () => {
  issued = null;
  row.sessionVersion = 4;

  const form = new FormData();
  form.set("code", "123456");
  const result = await actions.disablePlatformTotp(undefined, form);
  assert.equal(result.ok, "Two-factor authentication turned off.");

  const cookie = issued as Issued;
  assert.ok(cookie, "the acting admin must be re-issued a cookie");
  // 5 is what this transaction wrote. 6 is what the concurrent revoke-all left
  // behind — issuing at 6 would resurrect a session that was just killed.
  assert.equal(
    cookie!.sessionVersion,
    5,
    "the cookie must carry the version this transaction produced, not a later read",
  );
  assert.equal(row.sessionVersion, 6, "the other administrator's revocation still stands");
});

test("a disabled account is issued no replacement cookie at all", async () => {
  issued = null;
  row.sessionVersion = 4;
  row.disabledAt = new Date("2026-02-01T00:00:00Z");
  try {
    const form = new FormData();
    form.set("code", "123456");
    await actions.disablePlatformTotp(undefined, form);
    // Failing safe: signed out beats handed a session the account should not have.
    assert.equal(issued as Issued, null);
  } finally {
    row.disabledAt = null;
  }
});

test("both security actions pin the version rather than re-reading it", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "src/app/actions/platformSecurity.ts"),
    "utf8",
  );
  // The behavioural test above covers `disable`; `confirm` shares the helper, so
  // the guard that matters is that NEITHER call site passes a bare id for the
  // function to look up again.
  assert.doesNotMatch(source, /reissueActingPlatformSession\(actor\.id\)/);
  assert.equal((source.match(/reissueActingPlatformSession\(reissue\)/g) ?? []).length, 2);
  // …and the capture happens inside the transaction, where the row is locked.
  assert.equal((source.match(/reissue = await capturePlatformIdentity\(tx, actor\.id\)/g) ?? []).length, 2);
});
