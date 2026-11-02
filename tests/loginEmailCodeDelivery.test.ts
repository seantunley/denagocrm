import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import bcrypt from "bcryptjs";

// Review of #959: the emailed sign-in code said "sent" whether or not the email went. These run the REAL sign-in
// actions (login, requestEmailCode) with the mail failing, and check what the person is told.
const state = { delivered: true, sendAllowed: true, sends: 0 };
const cookieJar = new Map<string, string>();
const user = { id: "u1", email: "k@example.com", name: "Kristina", passwordHash: bcrypt.hashSync("right-password-1", 4), emailOtpEnabled: true, totpEnabledAt: null, totpSecret: null, sessionVersion: 0 };

const stubs: Record<string, unknown> = {
  "server-only": {},
  "next/navigation": { redirect: () => { throw new Error("NEXT_REDIRECT"); } },
  "next/headers": {
    cookies: async () => ({
      get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
      set: (name: string, value: string) => void cookieJar.set(name, value),
      delete: (name: string) => void cookieJar.delete(name),
    }),
  },
  "@/lib/db": { basePrisma: { user: { findUnique: async ({ where }: { where: { email?: string; id?: string } }) => (where.email === user.email || where.id === user.id ? user : null), update: async () => user } } },
  "@/lib/auth": { createSessionCookie: async () => {}, destroySessionCookie: async () => {} },
  "@/lib/session": { verifySession: async () => null, SESSION_COOKIE: "s" },
  "@/lib/errorLog": { logError: async () => {} },
  "@/lib/totp": { verifyTotp: () => false },
  "@/lib/backupCodes": { matchBackupCode: async () => null },
  "@/lib/settings": { decryptValue: (v: string) => v },
  "@/lib/accountEmail": { sendAccountEmail: async () => (state.sends++, state.delivered) },
  "@/lib/audit": { logAudit: async () => {} },
  "@/lib/rateLimit": {
    LOGIN_POLICY: {}, OTP_SEND_POLICY: {}, OTP_VERIFY_POLICY: {},
    clearRateLimit: async () => {}, getRequestIp: async () => "1.2.3.4", rateLimitKey: (a: string, b: string) => `${a}:${b}`,
    refundRateLimitAttempt: async () => {}, reserveRateLimitAttempt: async () => ({ allowed: true }),
    registerRateLimitAttempt: async () => ({ allowed: state.sendAllowed }),
  },
  "@/lib/userSecurity": {
    bumpUserSessionVersion: async () => 1, getUserSecurityState: async () => ({ disabledAt: null, sessionVersion: 0 }),
    recordFailedLogin: async () => {}, recordSuccessfulLogin: async () => 0,
  },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const { login, requestEmailCode } = createRequire(import.meta.url)("../src/app/login/actions.ts") as typeof import("../src/app/login/actions");

const signIn = () => {
  const form = new FormData();
  form.set("email", user.email);
  form.set("password", "right-password-1");
  return login(undefined, form);
};

beforeEach(() => {
  state.delivered = true;
  state.sendAllowed = true;
  state.sends = 0;
  cookieJar.clear();
});

test("email is the only second step and the code went: the code screen, no warning", async () => {
  const result = await signIn();
  assert.equal(result.need2fa, true);
  assert.equal(state.sends, 1);
  assert.equal(result.notice, undefined);
});

test("the email did NOT go: the code screen says so — never left waiting for a code that isn't coming", async () => {
  state.delivered = false;
  const result = await signIn();
  assert.equal(result.need2fa, true);
  assert.match(result.notice ?? "", /couldn't email your code/);
  assert.doesNotMatch(result.notice ?? "", /smtp|k@example\.com/i, "no mail settings or address in the message");
});

test("'Resend email code' reports a failed send as a failure, and a too-soon resend as too soon", async () => {
  await signIn();
  state.delivered = false;
  assert.match((await requestEmailCode()).error ?? "", /couldn't email your code/);
  state.delivered = true;
  assert.deepEqual(await requestEmailCode(), { ok: true });
  state.sendAllowed = false;
  assert.match((await requestEmailCode()).error ?? "", /sent recently/);
});

test("the code screen shows the failure instead of 'Code sent — check your inbox'", () => {
  const ui = readFileSync("src/app/login/LoginClient.tsx", "utf8");
  assert.match(ui, /<TwoFactorStep methods=\{state\.methods \?\? \[\]\} brand=\{brand\} notice=\{state\.notice\} \/>/);
  assert.match(ui, /setEmailError\(result\.error \?\? ""\);\s*setSent\(!result\.error\);/);
  assert.match(ui, /\{hasEmail && emailError \? <p role="alert"/);
});
