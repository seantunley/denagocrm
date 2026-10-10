/**
 * THE TEST THAT WOULD HAVE CAUGHT THE 2026-08-12 LOCKOUT.
 *
 * On 2026-08-12 `TENANT_ENFORCEMENT=enforce` went live and took the CRM down.
 * Every page redirected to /platform/login. Production logged, on `GET /`:
 *
 *     TenantScopeError: No tenant scope established for Dashboard
 *
 * The mechanism was precise, and it was not a flaky AsyncLocalStorage:
 *
 *   `getCurrentUser()` is wrapped in React `cache()`. The LAYOUT calls it first,
 *   the body runs, and `enterWith` binds the scope in the LAYOUT's async context.
 *   The PAGE then calls it and gets a CACHE HIT — the body never re-runs, so
 *   `enterWith` never fires in the page's context. The page queries with no
 *   scope, the guard refuses it, and because the principal is an owner the escape
 *   hatch in (app)/layout.tsx sends them to /platform/tenants, which needs a
 *   PlatformAdmin account they do not have.
 *
 * ── WHY EVERY EXISTING TEST MISSED IT ───────────────────────────────────────
 *
 * Every tenant test in this repo — test-tenant-e2e, test-rls-restricted, the
 * two-tenant harness — establishes scope by CALLING `runInTenantScope` itself and
 * then driving server-side functions in-process. None of them renders a page.
 * They prove the guard refuses unscoped queries; they cannot prove the real
 * chokepoint establishes a scope that the real render tree can see, because they
 * replace that chokepoint.
 *
 * docs/enterwith-request-scope-finding.md probed the mechanism on a real request
 * and found it worked — on the DEV SERVER, and it said so about itself: "Dev
 * server only (Turbopack). Not verified against a production build, where
 * bundling and React's server runtime differ." That sentence was the whole bug.
 *
 * ── SO THIS TEST DOES THE TWO THINGS NONE OF THEM DID ───────────────────────
 *
 *   1. It runs against a REAL PRODUCTION BUILD (`next build` + `next start`),
 *      because dev and production schedule React server segments differently and
 *      only production's behaviour matters.
 *   2. It goes over HTTP to `/`, the exact URL that broke, so the layout and the
 *      page both call the real `getCurrentUser()` and one of them takes the
 *      `cache()` hit. Nothing here establishes a scope by hand — if it did, it
 *      would be testing its own plumbing, which is precisely how we got here.
 *
 * Run: NODE_ENV=test npm run test:enforced-render
 * Set REUSE_BUILD=1 to skip `next build` when .next is already a production build.
 */
import { saveFile } from "../src/lib/storage";
import * as signTokens from "../src/lib/signing/tokens";
import { SIGNED_COPY_COOKIE, mintSignedCopyPass } from "../src/lib/signing/signedCopyPass";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { basePrisma } from "../src/lib/db";
import { signFreshSession, SESSION_COOKIE } from "../src/lib/session";
import { hashSignToken, newSignToken } from "../src/lib/signing/tokens";
import { blankDocument } from "../src/lib/doceditor/factory";

/**
 * Next's CLI, run through THIS node binary rather than through `npx`.
 *
 * `npx` resolves to `npx.cmd` on Windows, and Node refuses to spawn a `.cmd`
 * without `shell: true` (EINVAL) — while `shell: true` is exactly what we cannot
 * have, because it hides the server's real PID from `killTree`. Invoking the CLI
 * directly sidesteps both: one real process, no shell, identical on every
 * platform, and no dependency on what happens to be on PATH.
 */
const NEXT_BIN = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

const PORT = Number(process.env.ENFORCED_RENDER_PORT ?? 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const SFX = crypto.randomUUID().replaceAll("-", "").slice(0, 10);

/** Everything the server wrote to stdout/stderr while it was up. */
let serverOutput = "";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Same refusal every sibling integration script carries. This one writes rows and
 * boots a server, so pointing it at anything but a disposable database would be a
 * production incident rather than a failed test.
 */
function assertDisposableDatabase(): void {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
    throw new Error(
      `test-enforced-render refuses to run: expected NODE_ENV=test and a *_test database, ` +
        `got NODE_ENV=${process.env.NODE_ENV} db=${dbName || "(none)"}.`,
    );
  }
}

type Fixture = {
  tenantId: string;
  userId: string;
  cookie: string;
  /** Staff who are NOT owners: one whose role grants `library.view`, one with no role at all. */
  staff: { roleId: string; grantedUserId: string; grantedCookie: string; bareUserId: string; bareCookie: string };
};

/**
 * A tenant, an OWNER in it, and the session cookie a browser would hold.
 *
 * Owner specifically: the owner is the role that hit the escape hatch and landed
 * on /platform/login, so it is the role whose failure is silent-and-total rather
 * than a plain bounce to /login. Test the worse path.
 *
 * The cookie is minted with `signFreshSession` — the application's own signer,
 * with the same `tid` claim `createSessionCookie` sets — and deliberately with NO
 * `jti`, so `getCurrentUser` skips the session-registry lookup. We are testing
 * scope propagation, not the device log.
 */
async function seedFixture(): Promise<Fixture> {
  const tenantId = `render_${SFX}`;
  await basePrisma.tenant.create({
    data: { id: tenantId, name: `Render Probe ${SFX}`, slug: `render-probe-${SFX}`, active: true },
  });
  const user = await basePrisma.user.create({
    data: {
      name: "Render Probe Owner",
      email: `render-probe-${SFX}@example.test`,
      passwordHash: "not-a-real-hash-this-session-is-minted-directly",
      role: "owner",
    },
  });
  await basePrisma.tenantMember.create({ data: { tenantId, userId: user.id } });

  const cookie = await signFreshSession(
    { id: user.id, name: user.name, email: user.email, role: user.role, grants: "", sessionVersion: 0 },
    60,
    { tid: tenantId },
  );

  // Two members who are not owners. Owners skip the permission lookup entirely,
  // so an owner can never show whether that lookup finds the workspace it needs.
  const member = async (label: string) => {
    const created = await basePrisma.user.create({
      data: {
        name: `Render Probe ${label}`,
        email: `render-probe-${label.toLowerCase()}-${SFX}@example.test`,
        passwordHash: "not-a-real-hash-this-session-is-minted-directly",
        role: "member",
      },
    });
    await basePrisma.tenantMember.create({ data: { tenantId, userId: created.id } });
    const session = await signFreshSession(
      { id: created.id, name: created.name, email: created.email, role: created.role, grants: "", sessionVersion: 0 },
      60,
      { tid: tenantId },
    );
    return { id: created.id, cookie: session };
  };
  const granted = await member("Librarian");
  const bare = await member("Bystander");
  const role = await basePrisma.role.create({ data: { name: `Render Probe role ${SFX}`, tenantId } });
  await basePrisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "library.view", tenantId } });
  await basePrisma.userRole.create({ data: { userId: granted.id, roleId: role.id, tenantId } });

  return {
    tenantId,
    userId: user.id,
    cookie,
    staff: { roleId: role.id, grantedUserId: granted.id, grantedCookie: granted.cookie, bareUserId: bare.id, bareCookie: bare.cookie },
  };
}

async function cleanup(fx: Fixture | null): Promise<void> {
  if (!fx) return;
  // Narrow and ordered — children before parents. Best-effort: a failed cleanup
  // must not turn a passing test red, and the database is disposable anyway.
  await basePrisma.errorLog.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => {});
  await basePrisma.userRole.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => {});
  await basePrisma.rolePermission.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => {});
  await basePrisma.role.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => {});
  await basePrisma.tenantMember.deleteMany({ where: { tenantId: fx.tenantId } }).catch(() => {});
  await basePrisma.user.deleteMany({ where: { id: { in: [fx.staff.grantedUserId, fx.staff.bareUserId] } } }).catch(() => {});
  await basePrisma.user.delete({ where: { id: fx.userId } }).catch(() => {});
  await basePrisma.tenant.delete({ where: { id: fx.tenantId } }).catch(() => {});
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

/**
 * Kill the server AND anything it spawned. `next start` runs a child of its own,
 * so killing the parent alone leaves a process holding the port — the next run
 * then fails to bind, or worse, silently tests the PREVIOUS build.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/**
 * THE TWO COPIES A SIGNING LINK CAN HAND OUT, AND WHO MAY HAVE THEM.
 *
 * Both routes give a document to someone holding only a link, so both are asked
 * over HTTP, against the production build, as the people who must be refused:
 *
 *   the signed copy    belongs to the browser that just signed. Its link is
 *                      revoked by then, so the link authorises nothing — a pass
 *                      cookie does. No cookie, or another signer's, is a 403
 *                      that does not even say whether a copy exists.
 *   the copy to keep   before signing is for whoever the page would show the
 *                      document to — so not before the one-time code.
 *
 * Own workspace, left behind on purpose: taking a copy appends to the evidence
 * trail, which nothing may delete.
 */
async function checkSigningCopies(): Promise<void> {
  const tenantId = `copy_${SFX}`;
  const pdf = Buffer.from(`%PDF-1.4\n% signing copy probe ${SFX}\n`, "utf8");
  await basePrisma.tenant.create({ data: { id: tenantId, name: `Copy Probe ${SFX}`, slug: `copy-probe-${SFX}`, active: true } });
  const stored = await saveFile(pdf, `copy-probe-${SFX}.pdf`, "application/pdf", tenantId);

  const signer = (requestId: string, name: string, extra: Record<string, unknown> = {}) => {
    const token = signTokens.newSignToken();
    return basePrisma.signatureRecipient
      .create({ data: { tenantId, requestId, name, email: `${name.toLowerCase()}-${SFX}@example.test`, token: signTokens.hashSignToken(token), ...extra } })
      .then((row) => ({ id: row.id, token }));
  };
  const get = async (token: string, path: string, pass?: string) => {
    const response = await fetch(`${BASE}/api/signing/${token}/${path}`, {
      headers: pass ? { cookie: `${SIGNED_COPY_COOKIE}=${pass}` } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  };

  // A finished document: completed, both signers done, both links revoked.
  const finished = await basePrisma.signatureRequest.create({
    data: { tenantId, title: `Copy probe ${SFX}`, status: "completed", completedAt: new Date(), signedPdfRef: stored },
  });
  const done = { status: "signed", signedAt: new Date(), tokenRevokedAt: new Date() };
  const ada = await signer(finished.id, "Ada", done);
  const ben = await signer(finished.id, "Ben", done);

  const bare = await get(ada.token, "signed");
  const asked = await get(ada.token, "signed?check");
  check(
    "a finished link alone cannot fetch the signed copy, or learn whether one exists",
    bare.status === 403 && asked.status === 403 && !bare.body.includes("%PDF"),
    `signed → ${bare.status}, signed?check → ${asked.status}`,
  );
  const borrowed = await get(ada.token, "signed", mintSignedCopyPass(ben.id, tenantId));
  check("…nor can another signer's pass", borrowed.status === 403, `status ${borrowed.status}`);
  const pass = mintSignedCopyPass(ada.id, tenantId);
  const ready = await get(ada.token, "signed?check", pass);
  const copy = await get(ada.token, "signed", pass);
  check(
    "the browser that signed is told its copy is ready, and gets it",
    ready.status === 200 && ready.body.toString("utf8").includes('"ready"') && copy.status === 200 && copy.body.equals(pdf),
    `signed?check → ${ready.status} ${ready.body.toString("utf8").slice(0, 60)}, signed → ${copy.status} (${copy.body.length} bytes)`,
  );

  // An open document that asks for a one-time code nobody has entered yet.
  const open = await basePrisma.signatureRequest.create({
    data: { tenantId, title: `Copy probe open ${SFX}`, status: "sent", sentAt: new Date(), identityMode: "email_otp", unsignedPdfRef: stored },
  });
  const cy = await signer(open.id, "Cy", { status: "sent" });
  const early = await get(cy.token, "document");
  check("the copy to keep is refused before the one-time code", early.status === 403 && !early.body.includes("%PDF"), `status ${early.status}`);
  await basePrisma.signatureRecipient.update({ where: { id: cy.id }, data: { identityVerifiedAt: new Date(), identityMethod: "email_otp" } });
  const kept = await get(cy.token, "document");
  check("…and served once it has been entered", kept.status === 200 && kept.body.equals(pdf), `status ${kept.status} (${kept.body.length} bytes)`);
}

/** Is anything already bound to our port? A bare TCP connect — no HTTP assumed. */
function portIsOccupied(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: PORT });
    const done = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(2_000);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/**
 * `next start`, with enforcement ON.
 *
 * NODE_ENV is forced to `production` for the CHILD even though this script
 * demands `test` for itself. That is the entire point of the exercise: the dev
 * server already passed this once, on 2026-08-11, while production failed.
 */
async function startServer(): Promise<ChildProcess> {
  // REFUSE TO ADOPT SOMEBODY ELSE'S SERVER.
  //
  // The readiness poll below cannot tell our server from one that was already
  // listening — a leftover from an interrupted run, or a dev server somebody has
  // open. Both would answer, the assertions would run against a DIFFERENT BUILD,
  // and the suite would report a confident pass about code it never executed.
  // That is the same species of false confidence that produced the outage this
  // test exists for, so it is an error, not a warning.
  if (await portIsOccupied()) {
    throw new Error(
      `Something is already listening on ${BASE}. Refusing to run: the assertions would ` +
        `silently target that server instead of the build under test. Stop it, or set ` +
        `ENFORCED_RENDER_PORT to a free port.`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    TENANT_ENFORCEMENT: "enforce",
    PORT: String(PORT),
  };
  // NOT `shell: true`. A shell wrapper means `child.pid` is the shell's, so
  // `child.kill()` reaps the wrapper and leaves `next start` holding the port and
  // the stdio pipes — the script then never exits, which is exactly what happened
  // the first time this was run. Resolve the platform's own launcher instead and
  // keep a real PID.
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX, so killTree can signal the whole group.
    detached: process.platform !== "win32",
  });
  // Tee the server's output: echoed for a human, and KEPT, because the server's
  // own stderr is the most reliable witness there is that the guard refused a
  // query. See `serverOutput` at the assertion site.
  child.stdout?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
    process.stdout.write(`  [next] ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
    process.stderr.write(`  [next] ${d}`);
  });

  // Poll rather than parse the banner: the readiness line's wording is Next's to
  // change, a reachable socket is not.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited early (${child.exitCode})`);
    try {
      await fetch(`${BASE}/login`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  killTree(child);
  throw new Error(`next start was not reachable on ${BASE} within 90s`);
}

/**
 * THE CUSTOMER'S SIGNING PAGE, BEFORE AND AFTER THE ONE-TIME CODE.
 *
 * A document can be sent so that the signer must enter a code, mailed to the
 * address on file, before it opens. The page drew that check OVER the finished
 * document: the customer saw a code prompt, and the response underneath carried
 * every sheet. Holding the link was enough to read the document the code was
 * there to protect — in a browser's view-source, or with no browser at all.
 *
 * So this asks the way that reader would: one plain request for the page, no
 * JavaScript, and a look at what came back. It needs a real server because the
 * question is what the SERVER sends, which no amount of reading the component
 * can settle — the component was correct, and showed nothing.
 *
 * The second request is the control, and the assertion is worthless without it:
 * "the sentence is absent" is also true of a page that could never have shown
 * it. Marking the signer verified (what entering the code does) must make the
 * very same link return it.
 *
 * Own workspace, and left behind on purpose. Opening a document appends to its
 * evidence trail, which nothing may delete — by design — so the rows cannot be
 * removed, and sharing the workspace above would stop THAT one being removed
 * too. The database is disposable; the trail not being is the point.
 */
async function checkSigningGate(): Promise<void> {
  const tenantId = `gate_${SFX}`;
  const sentence = `Confidential clause ${SFX}`;
  const token = newSignToken();

  const document = blankDocument(`Gate probe ${SFX}`);
  const block = document.pages[0].rows[0].columns[0].blocks[1];
  if (block.type !== "text") throw new Error("blankDocument no longer starts with a heading and a text block");
  block.value = [{ type: "p", children: [{ text: sentence }] }];

  await basePrisma.tenant.create({ data: { id: tenantId, name: `Gate Probe ${SFX}`, slug: `gate-probe-${SFX}`, active: true } });
  const request = await basePrisma.signatureRequest.create({
    data: {
      tenantId,
      title: `Gate probe ${SFX}`,
      status: "sent",
      identityMode: "email_otp",
      sentAt: new Date(),
      snapshotJson: document as unknown as Prisma.InputJsonValue,
    },
  });
  const recipient = await basePrisma.signatureRecipient.create({
    data: {
      tenantId,
      requestId: request.id,
      name: "Gate Probe Signer",
      email: `gate-probe-${SFX}@example.test`,
      status: "sent",
      token: hashSignToken(token),
    },
  });

  const open = async () => {
    const response = await fetch(`${BASE}/signing/${token}`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    return { status: response.status, html: await response.text() };
  };
  const openedAt = async () =>
    (await basePrisma.signatureRecipient.findUniqueOrThrow({ where: { id: recipient.id }, select: { viewedAt: true } })).viewedAt;

  const before = await open();
  check(
    "a signer who has not entered their code is asked for it",
    before.status === 200 && before.html.includes("Verify your identity"),
    `status ${before.status}; the code prompt is ${before.html.includes("Verify your identity") ? "there" : "missing"}`,
  );
  check(
    "…and is sent none of the document",
    !before.html.includes(sentence),
    "the response carries the document's own text before any code was entered — the check is drawn over the " +
      "document instead of being answered before it is rendered (signing/[token]/page.tsx)",
  );
  check("…and the document is not recorded as opened by them", (await openedAt()) === null);

  // What entering the right code does (verifyIdentityChallenge).
  await basePrisma.signatureRecipient.update({
    where: { id: recipient.id },
    data: { identityVerifiedAt: new Date(), identityMethod: "email_otp" },
  });
  const after = await open();
  check(
    "once the code is accepted, the same link opens the document",
    after.status === 200 && after.html.includes(sentence),
    `status ${after.status}. Without this the check above proves nothing: a page that never renders the ` +
      `sentence would pass it too.`,
  );
  check("…and only then is it recorded as opened", (await openedAt()) !== null);
}

async function main(): Promise<void> {
  assertDisposableDatabase();

  if (process.env.REUSE_BUILD === "1" && existsSync(".next/required-server-files.json")) {
    console.log("Reusing the existing production build (.next).");
  } else {
    console.log("Building (next build) — this is the whole point, so it is not skippable by default.");
    await run(process.execPath, [NEXT_BIN, "build"], { ...process.env, NODE_ENV: "production" });
  }

  let fx: Fixture | null = null;
  let server: ChildProcess | null = null;
  const startedAt = new Date();
  try {
    fx = await seedFixture();
    server = await startServer();

    // A public page: no session, and none of the fixture above. It runs first so
    // the scope checks further down also cover a page reached by a link alone.
    await checkSigningGate();

    // The moment the outage is reproduced or not. `/` renders (app)/layout.tsx
    // AND (app)/page.tsx, both of which call getCurrentUser() — so one of them
    // takes the cache() hit. `redirect: "manual"` because the redirect IS the
    // symptom; following it would hide the thing we are looking for.
    const res = await fetch(`${BASE}/`, {
      headers: { cookie: `${SESSION_COOKIE}=${fx.cookie}` },
      redirect: "manual",
      // A hung render must fail the test, not the run. Without this the script
      // waits forever and CI reports a timeout, which reads as flake rather than
      // as the outage this exists to catch.
      signal: AbortSignal.timeout(30_000),
    });
    const location = res.headers.get("location") ?? "";
    const body = res.status === 200 ? await res.text() : "";

    check(
      "GET / is not bounced to the platform console",
      !location.includes("/platform"),
      `The owner escape hatch fired: the request resolved NO tenant scope, so ` +
        `(app)/layout.tsx redirected to ${location || "(none)"} — a console the owner ` +
        `has no account for. This is the 2026-08-12 lockout, exactly.`,
    );

    check(
      "GET / is not bounced to the login page",
      !location.endsWith("/login") && !location.includes("/login?"),
      `Redirected to ${location}. A non-owner sees this instead of the console bounce: ` +
        `establishStaffTenantScope failed closed and getCurrentUser returned null.`,
    );

    check(
      "GET / renders the signed-in dashboard",
      res.status === 200,
      `status ${res.status}${location ? ` → ${location}` : ""}`,
    );

    // Public routes reached by a signing link alone — see checkSigningCopies.
    // Before the scope checks below, so those cover these requests as well.
    await checkSigningCopies();

    // THE SERVER'S OWN STDERR, which is the assertion that actually holds.
    //
    // Verified by deleting the fix and re-running: the guard threw
    // `TenantScopeError: No tenant scope established for Dashboard` straight into
    // the server's stderr, while the ErrorLog check below reported "ok" — the
    // render aborted before anything durable was written, so the database saw
    // nothing. Production DID log it there, which is precisely why an assertion
    // that depends on a best-effort write is not good enough here.
    check(
      "the server logged no TenantScopeError",
      !serverOutput.includes("TenantScopeError"),
      "the guard refused a query during the render — the scope did not reach the page",
    );

    // The durable record, kept as a SECOND witness rather than the only one. It
    // is the shape production reported the outage in, so a regression that does
    // reach ErrorLog is caught with the same words the incident used.
    const scopeErrors = await basePrisma.errorLog.findMany({
      // Time-bounded. A scope failure logs with `tenantId` NULL — that is the
      // whole point of ErrorLog being a global model — so it cannot be found by
      // our fixture's tenant, and an unbounded search would inherit rows from
      // whatever else ran against this CI database first.
      where: {
        message: { contains: "No tenant scope established" },
        createdAt: { gte: startedAt },
      },
      select: { message: true, context: true },
      take: 5,
    });
    check(
      "no TenantScopeError was logged while rendering",
      scopeErrors.length === 0,
      scopeErrors.map((e) => `${e.context ?? "?"} — ${e.message}`).join("\n       "),
    );

    // FIDELITY GUARD, and it is not optional decoration.
    //
    // A 200 that rendered the login page, an error boundary or an empty shell
    // would satisfy every assertion above while proving nothing. The probe user's
    // own name only reaches the HTML through the authenticated layout, which is
    // downstream of the scope this test exists to check.
    if (res.status === 200) {
      check(
        "the rendered page is the authenticated shell",
        body.includes("Render Probe Owner"),
        "200 OK, but the signed-in user's name is absent from the HTML — the assertions " +
          "above may have passed against a page that never rendered the authenticated layout",
      );
    }

    // ── A ROUTE HANDLER, AS STAFF WHO ARE NOT OWNERS ──────────────────────────
    //
    // Everything above is a page, as an owner. A route handler has no layout
    // above it to establish the workspace, and the permission lookup counts a
    // role only in the workspace being acted in — so a handler that asks
    // `hasPermission(user, …)` without binding one looked the user's roles up in
    // no workspace and refused everybody who was not an owner. Eleven handlers
    // did, the document download among them, and nothing here could see it: the
    // only user this test had was an owner, who skips the lookup.
    //
    // A made-up id, so nothing has to exist to be served: past the permission
    // check the route answers 404, and refused by it, 403. The owner is the
    // control that the route works at all; the member with no role is the
    // control that passing is not the same as being open.
    const libraryFile = (session: string) =>
      fetch(`${BASE}/api/library/does-not-exist`, {
        headers: { cookie: `${SESSION_COOKIE}=${session}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      }).then((response) => response.status);
    const [asOwner, asGranted, asBare] = [await libraryFile(fx.cookie), await libraryFile(fx.staff.grantedCookie), await libraryFile(fx.staff.bareCookie)];
    check("a route handler lets the owner past its permission check", asOwner === 404, `status ${asOwner} (404 = past the check, nothing to serve)`);
    check(
      "…and a member whose role grants the permission",
      asGranted === 404,
      `status ${asGranted}. 403 means the handler read the member's roles in NO workspace and found none: ` +
        `it checked permissions without binding the acting workspace (withActingStaffScope). ` +
        `Owners skip that lookup, so only a non-owner shows it.`,
    );
    check("…but not a member whose role does not", asBare === 403, `status ${asBare} — the route must still refuse someone without the permission`);
  } finally {
    if (server) {
      killTree(server);
      await new Promise((r) => setTimeout(r, 500));
    }
    await cleanup(fx);
    await basePrisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      "\nEnforced-mode rendering is BROKEN. Do not set TENANT_ENFORCEMENT=enforce in production:\n" +
        "every signed-in page will fail closed, and an owner will be redirected to a platform\n" +
        "console they have no account for — a total lockout with no in-app way back.",
    );
    process.exit(1);
  }
  // Explicit: a stray handle from the killed server must not turn a passing run
  // into a hang. The assertions are done; there is nothing left to wait for.
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
