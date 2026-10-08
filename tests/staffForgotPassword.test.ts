import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import Module, { createRequire } from "node:module";
import bcrypt from "bcryptjs";

// Gap audit #25: "Forgot password?" for staff — behaviour against an in-memory
// database. The properties that matter: no account enumeration, single-use
// short-lived codes, capped guesses, everyone signed out, never auto-signed-in.

type Challenge = { id: string; purpose: string; key: string; codeHash: string; attempts: number; expiresAt: Date; verifiedAt: Date | null; createdAt: Date };
const db = {
  users: [] as Array<{ id: string; name: string; email: string; passwordHash: string; disabled?: boolean }>,
  challenges: [] as Challenge[],
  sessionBumps: [] as string[],
  emails: [] as Array<{ to: string; subject: string; text: string }>,
  afterQueue: [] as Array<() => unknown>,
};
let seq = 0;

const basePrisma = {
  user: {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
      db.users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: { passwordHash?: string } }) => {
      const u = db.users.find((x) => x.id === where.id)!;
      if (data.passwordHash) u.passwordHash = data.passwordHash;
      return u;
    },
  },
  otpChallenge: {
    // Synchronous body = one atomic statement, like a single UPDATE on the row.
    updateMany: async ({
      where,
      data,
    }: {
      where: Partial<Omit<Challenge, "attempts">> & { attempts?: { lt: number } };
      data: Partial<Omit<Challenge, "attempts">> & { attempts?: { increment: number } };
    }) => {
      const rows = db.challenges.filter(
        (c) =>
          (where.id === undefined || c.id === where.id) &&
          (where.purpose === undefined || c.purpose === where.purpose) &&
          (where.key === undefined || c.key === where.key) &&
          (where.verifiedAt === undefined || c.verifiedAt === where.verifiedAt) &&
          (where.attempts === undefined || c.attempts < where.attempts.lt),
      );
      const { attempts, ...rest } = data;
      for (const r of rows) {
        Object.assign(r, rest);
        if (attempts) r.attempts += attempts.increment;
      }
      return { count: rows.length };
    },
    create: async ({ data }: { data: Omit<Challenge, "id" | "attempts" | "verifiedAt" | "createdAt"> }) => {
      const row = { ...data, id: `c${++seq}`, attempts: 0, verifiedAt: null, createdAt: new Date(Date.now() + seq) };
      db.challenges.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: { purpose: string; key: string } }) =>
      db.challenges
        .filter((c) => c.purpose === where.purpose && c.key === where.key && c.verifiedAt === null && c.expiresAt > new Date())
        .sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null,
    update: async ({ where, data }: { where: { id: string }; data: { attempts: { increment: number } } }) => {
      const c = db.challenges.find((x) => x.id === where.id)!;
      c.attempts += data.attempts.increment;
      return c;
    },
  },
  $executeRaw: async () => 0,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(basePrisma),
};

const stubs: Record<string, unknown> = {
  "server-only": {},
  "next/server": { after: (cb: () => unknown) => void db.afterQueue.push(cb) },
  "@/lib/db": { basePrisma, prisma: basePrisma },
  "@/lib/email": { sendEmail: async (m: { to: string; subject: string; text: string }) => void db.emails.push(m) },
  "@/lib/audit": { logAudit: async () => {} },
  "@/lib/errorLog": { logError: async () => {} },
  "@/lib/platformIdentity": { PLATFORM_NAME: "CRM" },
  "@/lib/userSecurity": {
    getUserSecurityStateFresh: async (id: string) => {
      const u = db.users.find((x) => x.id === id);
      return u ? { disabledAt: u.disabled ? new Date() : null } : null;
    },
    bumpUserSessionVersion: async (id: string) => void db.sessionBumps.push(id),
  },
  "@/lib/rateLimit": {
    LOGIN_POLICY: {},
    OTP_SEND_POLICY: {},
    OTP_VERIFY_POLICY: {},
    checkRateLimit: async () => ({ allowed: true }),
    clearRateLimit: async () => {},
    getRequestIp: async () => "1.2.3.4",
    rateLimitKey: (a: string, b: string) => `${a}:${b}`,
    registerRateLimitAttempt: async () => ({ allowed: true }),
  },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const { requestPasswordReset, resetPasswordWithCode } = createRequire(import.meta.url)(
  "../src/app/login/resetActions.ts",
) as typeof import("../src/app/login/resetActions");

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const runAfter = async () => {
  const q = db.afterQueue.splice(0);
  for (const cb of q) await cb();
};
const codeFromEmail = () => /code is (\d{6})/.exec(db.emails.at(-1)!.text)![1];

beforeEach(async () => {
  db.users = [{ id: "u1", name: "Jo", email: "jo@acme.test", passwordHash: await bcrypt.hash("oldpassword123", 4) }];
  db.challenges = [];
  db.sessionBumps = [];
  db.emails = [];
  db.afterQueue = [];
});

test("the request step answers the same for a real and an unknown email, and does nothing account-specific before replying", async () => {
  const known = await requestPasswordReset(undefined, fd({ email: "Jo@Acme.test " }));
  const unknown = await requestPasswordReset(undefined, fd({ email: "nobody@acme.test" }));
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
  assert.equal(known.sent, true);
  assert.equal(unknown.sent, true);
  assert.equal(db.challenges.length, 0, "no code before the response");
  assert.equal(db.emails.length, 0, "no email before the response");
  await runAfter();
  assert.equal(db.emails.length, 1, "only the real account gets an email");
  assert.equal(db.emails[0].to, "jo@acme.test");
  assert.equal(db.challenges.length, 1);
  assert.ok(!db.challenges[0].codeHash.includes(codeFromEmail()), "the code is stored hashed");
});

test("a disabled account gets no code", async () => {
  db.users[0].disabled = true;
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  assert.equal(db.emails.length, 0);
});

test("the right code resets the password, signs out everywhere, and does not sign in", async () => {
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const res = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: codeFromEmail(), password: "brandnewpass42" }));
  assert.deepEqual(res, { done: true });
  assert.ok(await bcrypt.compare("brandnewpass42", db.users[0].passwordHash));
  assert.deepEqual(db.sessionBumps, ["u1"]);
  await runAfter();
  assert.match(db.emails.at(-1)!.subject, /password was changed/);
});

test("a code works once", async () => {
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const code = codeFromEmail();
  await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code, password: "brandnewpass42" }));
  const again = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code, password: "anotherpass99" }));
  assert.ok(again.error);
  assert.ok(await bcrypt.compare("brandnewpass42", db.users[0].passwordHash), "the second use changed nothing");
});

test("a new code expires the old one", async () => {
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const first = codeFromEmail();
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const res = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: first, password: "brandnewpass42" }));
  assert.ok(res.error, "the earlier code no longer works");
});

test("wrong guesses are capped at five, even for the right code afterwards", async () => {
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const code = codeFromEmail();
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 0; i < 5; i++) {
    const r = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: wrong, password: "brandnewpass42" }));
    assert.ok(r.error);
  }
  const late = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code, password: "brandnewpass42" }));
  assert.ok(late.error, "the code is dead after five wrong tries");
  assert.equal(db.sessionBumps.length, 0);
});

test("a burst of concurrent guesses still gets only five — the sixth is refused even when it's right", async () => {
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const code = codeFromEmail();
  const wrong = code === "111111" ? "222222" : "111111";
  // All in flight at once: each reads the challenge before any result is known.
  const guesses = [...Array(9).fill(wrong), code];
  const results = await Promise.all(
    guesses.map((g) => resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: g, password: "brandnewpass42" }))),
  );
  assert.ok(results.every((r) => r.error), "the right code arrived after five tries were spent");
  assert.equal(db.challenges[0].attempts, 5, "never more than five reserved");
  assert.equal(db.sessionBumps.length, 0);
  assert.ok(await bcrypt.compare("oldpassword123", db.users[0].passwordHash), "password unchanged");
});

test("an unknown email gets the same answer as a wrong code", async () => {
  const unknown = await resetPasswordWithCode(undefined, fd({ email: "nobody@acme.test", code: "123456", password: "brandnewpass42" }));
  await requestPasswordReset(undefined, fd({ email: "jo@acme.test" }));
  await runAfter();
  const wrong = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: codeFromEmail() === "123456" ? "654321" : "123456", password: "brandnewpass42" }));
  assert.equal(unknown.error, wrong.error);
});

test("the new password must meet the same floor", async () => {
  const r = await resetPasswordWithCode(undefined, fd({ email: "jo@acme.test", code: "123456", password: "short" }));
  assert.match(r.error ?? "", /at least 12 characters/);
});
