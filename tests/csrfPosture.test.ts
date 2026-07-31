import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * CSRF posture.
 *
 * The audit found this sound, so there is no fix here — these tests exist
 * because every property below is the ABSENCE of a weakening, and absences are
 * exactly what a well-meaning change removes without noticing. Each one is a
 * one-line edit away from being gone, and none of them would fail a build,
 * a typecheck, or any behavioural test.
 */

test("every session cookie is SameSite=Lax or stricter", () => {
  // This is the primary CSRF control: Lax withholds the cookie on cross-site
  // POST, so a form on evil.com cannot act as a signed-in user. `none` would
  // remove that in one word — and `none` is what people reach for when an
  // embed or an iframe integration misbehaves.
  const cookieFiles = [
    "src/lib/session.ts", // staff
    "src/lib/portal.ts", // customer portal
    "src/lib/platformSession.ts", // platform console
    "src/lib/webauthn.ts", // passkey challenge
    "src/app/login/actions.ts", // pending-2FA cookie
  ];
  for (const rel of cookieFiles) {
    const code = src(rel);
    assert.match(code, /sameSite:\s*"(lax|strict)"/, `${rel} must set SameSite lax or strict`);
    assert.doesNotMatch(code, /sameSite:\s*"none"/, `${rel} must never use SameSite=none`);
  }
});

test("session cookies are httpOnly and secure in production", () => {
  // httpOnly keeps XSS from reading the session; secure keeps it off plaintext.
  for (const rel of ["src/lib/session.ts", "src/lib/portal.ts", "src/lib/platformSession.ts"]) {
    const code = src(rel);
    assert.match(code, /httpOnly:\s*true/, `${rel} must set httpOnly`);
    assert.match(code, /secure:\s*process\.env\.NODE_ENV === "production"|secure:\s*true/, `${rel} must set secure`);
  }
});

test("server actions keep Next's built-in origin check", () => {
  // Next compares Origin against Host on every server action and rejects a
  // mismatch. `serverActions.allowedOrigins` widens that, and is the one
  // config option that would silently disable CSRF protection app-wide.
  const config = src("next.config.ts");
  assert.doesNotMatch(
    config,
    /allowedOrigins/,
    "allowedOrigins weakens the origin check that protects every server action",
  );
});

test("no cookie-authenticated route mutates on GET", () => {
  // SameSite=Lax DOES send the cookie on a top-level GET navigation, so a
  // mutating GET reachable with a session cookie is CSRF-able by a plain link
  // — the one hole Lax does not close.
  //
  // The routes below mutate on GET and are allowed to, because none of them
  // authenticate with a cookie: they use a secret header or a bearer token an
  // attacker cannot make a victim's browser attach.
  const allowed = new Map<string, string>([
    ["src/app/api/cron/automations/route.ts", "CRON_SECRET in the Authorization header"],
    ["src/app/api/cron/backup/route.ts", "CRON_SECRET in the Authorization header"],
    ["src/app/api/track/c/[token]/route.ts", "per-recipient token in the path"],
    ["src/app/api/track/o/[token]/route.ts", "per-recipient token in the path"],
    ["src/app/api/unsubscribe/[token]/route.ts", "per-recipient token in the path"],
  ]);

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(full);
    }
    return out;
  };

  const offenders: string[] = [];
  for (const file of walk(path.join(root, "src", "app", "api"))) {
    const code = readFileSync(file, "utf8");
    const getBody = code.match(/export async function GET[\s\S]*?(?=\nexport |$)/)?.[0];
    if (!getBody) continue;
    const mutates = /\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(|executeRaw/.test(getBody);
    if (!mutates) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (allowed.has(rel)) continue;
    // Cookie-authenticated? Then a link is enough to trigger the write.
    if (/getCurrentUser|requireUser|requireApi|getPortalContact|requirePlatformAdmin/.test(code)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these mutate on GET while authenticating by cookie — CSRF-able by a plain link:\n  ${offenders.join("\n  ")}`,
  );
});

test("the mutating-GET allowlist has not gone stale", () => {
  // An entry that no longer mutates should be removed, so the list keeps
  // meaning something rather than becoming decoration.
  for (const rel of [
    "src/app/api/cron/automations/route.ts",
    "src/app/api/cron/backup/route.ts",
    "src/app/api/track/c/[token]/route.ts",
    "src/app/api/track/o/[token]/route.ts",
    "src/app/api/unsubscribe/[token]/route.ts",
  ]) {
    const full = path.join(root, rel);
    assert.ok(statSync(full).isFile(), `${rel} is allowlisted but no longer exists`);
    assert.doesNotMatch(
      src(rel),
      /getCurrentUser|requireUser\(/,
      `${rel} now authenticates by cookie — it can no longer mutate on GET`,
    );
  }
});
