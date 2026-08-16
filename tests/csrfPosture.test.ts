import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A database write, wherever it is reached from.
 *
 * The receiver is part of the pattern on purpose. A bare `\.update\(` matches
 * `decipher.update()` in settings.ts and `cipher.update()` next to it, and the
 * first version of this transitive check duly reported two read-only routes as
 * mutating — a false positive is how a test like this gets muted.
 */
const MUTATION =
  /\b(prisma|basePrisma|tx|transaction|client|db)\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany|createManyAndReturn|updateManyAndReturn)\(|\$executeRaw|\$queryRawUnsafe|executeRawUnsafe/;

/**
 * Calls that write only an append-only record OF the request that just
 * happened. Not followed.
 *
 * These do write rows, so the analysis is right to see them — but an audit entry
 * saying "this person exported the audit log" is not a state change an attacker
 * gains anything from, and the alternative (exports that do not audit) is worse
 * than the risk. The bounded downside is log volume, at the rate a victim can be
 * induced to click. A route reached this way is still flagged for any OTHER
 * write it makes.
 */
const AUDIT_ONLY = new Set(["logAudit", "logAuditStrict", "writeAudit", "logError", "logSignEvent"]);

/**
 * Resolve a module specifier to a file under src/, or null if it leaves the
 * repo. `@/` is the tsconfig alias for `src/`.
 */
function resolveModule(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(root, "src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : null; // a node_modules package — not ours to follow
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Top-level function-ish declarations in a module, plus its import map. */
function moduleIndex(file: string) {
  const code = readFileSync(file, "utf8");
  const decls = new Map<string, string>();
  // `function name(...) { ... }` and `const name = (...) => { ... }`, captured
  // up to the next top-level declaration. Coarse, and deliberately so: this is a
  // reachability net, and over-capturing errs toward flagging, not toward
  // missing a write.
  for (const m of code.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)[\s\S]*?(?=\n(?:export\s+)?(?:async\s+)?(?:function|const|class)\s|\n*$)/g)) {
    decls.set(m[1], m[0]);
  }
  for (const m of code.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([\s\S]*?(?=\n(?:export\s+)?(?:async\s+)?(?:function|const|class)\s|\n*$)/g)) {
    if (!decls.has(m[1])) decls.set(m[1], m[0]);
  }
  const imports = new Map<string, string>();
  for (const m of code.matchAll(/import\s*\{([^{}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveModule(file, m[2]);
    if (!target) continue;
    for (const name of m[1].split(",")) {
      const local = name.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) imports.set(local, target);
    }
  }
  // `const { a, b } = await import("./x")` — the dynamic form, used across this
  // codebase to keep server-only modules out of the client bundle.
  // `[^{}]`, not `[^}]`: the latter starts matching at the enclosing function's
  // opening brace and captures `const { performMutation` as the binding name,
  // which silently resolves nothing. That bug made the fixture below pass as
  // "no mutation found" — the exact false negative this test exists to prevent.
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g)) {
    const target = resolveModule(file, m[2]);
    if (!target) continue;
    for (const name of m[1].split(",")) {
      const local = name.trim().split(/\s*:\s*/).pop()?.trim();
      if (local) imports.set(local, target);
    }
  }
  return { decls, imports };
}

/**
 * Where a handler's writes happen — "inline", a `file#function` it reaches, or
 * null if nothing reachable writes.
 *
 * Follows calls into same-file declarations and imported modules under src/,
 * depth-bounded. The GET body is passed separately because the caller has
 * already sliced it out of the route file.
 *
 * KNOWN IMPRECISION, stated rather than papered over. Declaration boundaries are
 * found by regex, not by parsing, so a declaration can over-capture into the
 * next one and attribute its writes to the wrong function; re-exports,
 * namespace imports (`import * as x`), default exports, and calls through a
 * variable are not followed at all; and the depth cap is 4. Every one of those
 * gaps errs in a different direction, so this is a NET, not a proof — it exists
 * to catch the accident (a write moved into a helper by a refactor), which the
 * previous body-only check could not see at all. Anything it flags is worth
 * reading; anything it misses is still on the reviewer.
 */
function mutationPath(file: string, body: string, depth = 4, seen = new Set<string>()): string | null {
  if (MUTATION.test(body)) return "inline";
  if (depth <= 0) return null;
  const index = moduleIndex(file);
  // The body may be the route file's own GET, whose local helpers are in the
  // same index; merge so a locally-declared helper resolves.
  for (const call of body.matchAll(/\b(\w+)\s*\(/g)) {
    const name = call[1];
    if (AUDIT_ONLY.has(name)) continue;
    const target = index.decls.has(name)
      ? { file, source: index.decls.get(name)! }
      : index.imports.has(name)
        ? (() => {
            const f = index.imports.get(name)!;
            const decl = moduleIndex(f).decls.get(name);
            return decl ? { file: f, source: decl } : null;
          })()
        : null;
    if (!target) continue;
    const key = `${target.file}#${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const via = mutationPath(target.file, target.source, depth - 1, seen);
    if (via) return via === "inline" ? `${path.relative(root, target.file).split(path.sep).join("/")}#${name}` : via;
  }
  return null;
}

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
    // /api/unsubscribe used to be here. It is not exempt any more — it simply
    // does not write on GET. See the dedicated test below.
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
    // TRANSITIVE. Looking only at the GET body itself was the blind spot: a
    // handler that calls `await performMutation()` writes just as surely as one
    // that inlines `prisma.x.update()`, and passed silently. mutationPath
    // follows calls into same-file declarations and imported modules under
    // src/, so the write is found wherever it actually lives.
    const via = mutationPath(file, getBody);
    if (!via) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (allowed.has(rel)) continue;
    // Cookie-authenticated? Then a link is enough to trigger the write.
    if (/getCurrentUser|requireUser|requireApi|getPortalContact|requirePlatformAdmin/.test(code)) {
      offenders.push(`${rel}  (writes via ${via})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these mutate on GET while authenticating by cookie — CSRF-able by a plain link:\n  ${offenders.join("\n  ")}`,
  );
});

test("the unsubscribe GET renders a page and writes nothing", () => {
  // It is not on the allowlist above any more, and this is why: it does not
  // mutate on GET at all. A per-recipient token in the path made the old
  // mutating GET safe from CSRF — but not from LINK PREFETCHING, which is a
  // different attacker with a different motive (none). Corporate mail scanners,
  // Safe-Links rewriters and client prefetchers walk every URL in a message, and
  // each walk silently unsubscribed a customer who never clicked. That loss is
  // undetectable after the fact: a scanner's opt-out row looks exactly like a
  // real one.
  //
  // Restoring the write to GET would pass every other test in this file, because
  // this route authenticates with a token rather than a cookie. Hence a check
  // that names it directly.
  const rel = "src/app/api/unsubscribe/[token]/route.ts";
  const code = src(rel);
  const file = path.join(root, rel);

  const getBody = code.match(/export async function GET[\s\S]*?(?=\nexport |$)/)?.[0];
  assert.ok(getBody, "the confirmation page is served by GET");
  assert.equal(
    mutationPath(file, getBody),
    null,
    "GET must render the confirmation page only — the opt-out belongs on POST",
  );

  // …and the opt-out must still exist somewhere, or "no write on GET" would be
  // satisfied by an unsubscribe link that does nothing at all.
  const postBody = code.match(/export async function POST[\s\S]*?(?=\nexport |$)/)?.[0];
  assert.ok(postBody, "the opt-out is performed by POST");
  assert.ok(mutationPath(file, postBody), "POST must actually record the opt-out");
});

test("the mutating-GET check sees through a helper, not just an inline write", () => {
  // Guards the guard. The original version matched Prisma calls in the GET body
  // and nothing else, so moving one line into a helper silenced it — which is
  // exactly what a refactor does by accident. These fixtures prove the analysis
  // follows a call, and still says no when there is genuinely no write.
  const dir = mkdtempSync(path.join(tmpdir(), "csrf-posture-"));
  try {
    writeFileSync(
      path.join(dir, "writer.ts"),
      `import { prisma } from "@/lib/db";\nexport async function performMutation(id: string) {\n  await prisma.thing.update({ where: { id }, data: { seen: true } });\n}\n`,
    );
    writeFileSync(
      path.join(dir, "reader.ts"),
      `import { prisma } from "@/lib/db";\nexport async function readOnly(id: string) {\n  return prisma.thing.findUnique({ where: { id } });\n}\n`,
    );

    // Each case gets its own route file, because the analysis reads local
    // declarations from the file on disk — sharing one would let the previous
    // fixture's body leak into the next assertion.
    const write = (name: string, body: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      return { file, body };
    };

    const indirect = write(
      "indirect.ts",
      `export async function GET(req: Request) {\n  const { performMutation } = await import("./writer");\n  await performMutation("x");\n  return Response.json({ ok: true });\n}\n`,
    );
    assert.ok(
      mutationPath(indirect.file, indirect.body),
      "a GET that writes through a helper must be detected — this was the blind spot",
    );

    const clean = write(
      "clean.ts",
      `export async function GET(req: Request) {\n  const { readOnly } = await import("./reader");\n  return Response.json(await readOnly("x"));\n}\n`,
    );
    assert.equal(
      mutationPath(clean.file, clean.body),
      null,
      "…without flagging a handler whose helper only reads",
    );

    const direct = write(
      "direct.ts",
      `import { prisma } from "@/lib/db";\nexport async function GET() {\n  await prisma.thing.create({ data: {} });\n}\n`,
    );
    assert.equal(mutationPath(direct.file, direct.body), "inline", "and the direct case still works");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mutating-GET allowlist has not gone stale", () => {
  // An entry that no longer mutates should be removed, so the list keeps
  // meaning something rather than becoming decoration.
  for (const rel of [
    "src/app/api/cron/automations/route.ts",
    "src/app/api/cron/backup/route.ts",
    "src/app/api/track/c/[token]/route.ts",
    "src/app/api/track/o/[token]/route.ts",
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
