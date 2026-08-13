/**
 * THE TEST THAT WOULD HAVE CAUGHT THE 2026-08-13 RESEARCH FAILURE.
 *
 * On 2026-08-13, clicking "Research" on a contact failed four times in production:
 *
 *     TenantScopeError: contact access check: this request has no resolvable
 *     workspace.                                context: POST /contacts/<id>
 *
 * Four PRs shipped against it — #513, #517, #518, #519 — and every one of them was
 * validated the same way: merge, deploy, wait for the next click. The failure at
 * 09:52:02 and 09:52:39 landed on the #519 build, which went READY at 09:51:41.
 *
 * ── WHY test-enforced-render.ts (#515) DID NOT CATCH IT ─────────────────────
 *
 * #515 does the hard part already: a REAL `next build` + `next start` with
 * TENANT_ENFORCEMENT=enforce, a real signed cookie, over HTTP. But it renders `/`.
 * A GET establishes the tenant scope through the layout, where React `cache()` HAS
 * a request store and #513's holder can carry the scope between segments.
 *
 * A SERVER ACTION HAS NO REQUEST STORE FOR `cache()`. The holder is never filled,
 * so AsyncLocalStorage is the only carrier left, and the POST path is therefore a
 * materially different mechanism from the GET path that #515 proves. Nothing in
 * this repo has ever exercised it.
 *
 * ── SO THIS TEST DOES THE ONE THING NONE OF THEM DID ────────────────────────
 *
 * It POSTs the real `researchRecord` Server Action, over HTTP, to a production
 * build, under enforcement, with a real session cookie — the exact shape that
 * fails — and asserts the guard did not refuse.
 *
 * ── DATABASE ────────────────────────────────────────────────────────────────
 *
 * The DEV Neon branch (ep-soft-river), read from .env.local. This script REFUSES
 * to run against the production endpoint: it writes rows and boots a server, so
 * pointing it at prod would be an incident rather than a failed test. There is no
 * `*_test` database on this machine and no local Postgres, which is why the
 * disposable-database rule of the sibling scripts is replaced by an explicit
 * endpoint allow-list.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const PORT = Number(process.env.ACTION_SCOPE_PORT ?? 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const SFX = crypto.randomBytes(4).toString("hex");
const NEXT_BIN = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

/** The ONLY database endpoint this script may touch. */
const DEV_ENDPOINT = "ep-soft-river";
const PROD_ENDPOINT = "ep-patient-waterfall";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Load .env then .env.local into process.env, exactly as Next does for
 * `next start` (.env.local wins). Done by hand because tsx does not load env
 * files and Prisma's own loader reads ONLY .env — which is the production
 * endpoint. Relying on that default is how a diagnostic script ends up writing
 * to prod.
 */
function loadEnvFiles(): void {
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value; // later file wins, deliberately
    }
  }
}

function assertDevDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("No DATABASE_URL after loading .env/.env.local.");
  if (url.includes(PROD_ENDPOINT)) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL points at the PRODUCTION endpoint (${PROD_ENDPOINT}). ` +
        `This script seeds and deletes rows and boots a server. Point it at the dev branch.`,
    );
  }
  if (!url.includes(DEV_ENDPOINT)) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL is neither the dev endpoint (${DEV_ENDPOINT}) nor a ` +
        `recognised target. Refusing rather than guessing which database this is.`,
    );
  }
  console.log(`Database: ${DEV_ENDPOINT} (dev branch) — confirmed not production.`);
}

type Fixture = { tenantId: string; userId: string; contactId: string; cookie: string };

/**
 * A tenant, an OWNER in it, a contact owned by it, and the session cookie a
 * browser would hold.
 *
 * OWNER specifically, for the same reason #515 uses one: the owner is the role
 * whose failure is silent-and-total, because `decideStaffTenantScope` hands an
 * owner with no resolvable tenant `{ok: true, enterTenantId: null}` — success
 * with NO scope. Any test using a lesser role would fail closed earlier and
 * never reach the branch under suspicion.
 */
async function seedFixture(): Promise<Fixture> {
  const { basePrisma } = await import("../src/lib/db");
  const { signFreshSession } = await import("../src/lib/session");
  const { encryptValue } = await import("../src/lib/settings");

  const tenantId = `action_${SFX}`;
  await basePrisma.tenant.create({
    data: { id: tenantId, name: `Action Probe ${SFX}`, slug: `action-probe-${SFX}`, active: true },
  });
  const user = await basePrisma.user.create({
    data: {
      name: "Action Probe Owner",
      email: `action-probe-${SFX}@example.test`,
      passwordHash: "not-a-real-hash-this-session-is-minted-directly",
      role: "owner",
      tenantId,
    },
  });
  await basePrisma.tenantMember.create({ data: { tenantId, userId: user.id } });
  const contact = await basePrisma.contact.create({
    data: { tenantId, firstName: "Action", lastName: `Probe ${SFX}`, email: `probe-${SFX}@example.test` },
  });

  // ResearchButton renders only when an ANTHROPIC_API_KEY setting exists for the
  // tenant. The key is deliberately INVALID: the guard we are testing runs long
  // before any outbound call, so the AI request may fail — it just must not be
  // the reason the button is absent.
  await basePrisma.appSetting.create({
    data: { tenantId, key: "ANTHROPIC_API_KEY", value: encryptValue("sk-ant-invalid-probe-key") },
  });

  // WITH A `jti`, AND THE MATCHING UserSession ROW — unlike #515, deliberately.
  //
  // #515 omits the jti so `getCurrentUser` skips the session-registry lookup. That
  // is right for what it tests, but it is NOT what a real browser holds: every
  // cookie minted by `createSessionCookie` carries one, so the real request does an
  // extra `prisma.userSession.findUnique` INSIDE `validateInSystemScope` — i.e.
  // inside a `runInTenantScope` system scope, which is precisely the async-context
  // machinery under suspicion. Reproducing without it would be reproducing a
  // simpler request than the one that fails.
  const jti = crypto.randomUUID();
  await basePrisma.userSession.create({
    data: { jti, userId: user.id, tenantId, platform: "web" },
  });

  const cookie = await signFreshSession(
    { id: user.id, name: user.name, email: user.email, role: user.role, grants: "", sessionVersion: 0 },
    60,
    { tid: tenantId, jti },
  );
  return { tenantId, userId: user.id, contactId: contact.id, cookie };
}

async function cleanup(fx: Fixture | null): Promise<void> {
  if (!fx) return;
  const { basePrisma } = await import("../src/lib/db");
  const swallow = () => {};
  await basePrisma.researchNote.deleteMany({ where: { contactId: fx.contactId } }).catch(swallow);
  await basePrisma.contact.deleteMany({ where: { tenantId: fx.tenantId } }).catch(swallow);
  await basePrisma.appSetting.deleteMany({ where: { tenantId: fx.tenantId } }).catch(swallow);
  await basePrisma.errorLog.deleteMany({ where: { tenantId: fx.tenantId } }).catch(swallow);
  await basePrisma.tenantMember.deleteMany({ where: { tenantId: fx.tenantId } }).catch(swallow);
  await basePrisma.user.delete({ where: { id: fx.userId } }).catch(swallow);
  await basePrisma.tenant.delete({ where: { id: fx.tenantId } }).catch(swallow);
}

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

let serverOutput = "";

async function startServer(): Promise<ChildProcess> {
  // Refuse to adopt somebody else's server: the readiness poll cannot tell ours
  // from a stray dev server, and assertions against the wrong build are exactly
  // the false confidence this whole exercise exists to end.
  if (await portIsOccupied()) {
    throw new Error(
      `Something is already listening on ${BASE}. Refusing to run — the assertions would ` +
        `target that server instead of the build under test. Set ACTION_SCOPE_PORT.`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    TENANT_ENFORCEMENT: "enforce", // the mode production is actually in
    ACTING_SCOPE_DEBUG: process.env.ACTING_SCOPE_DEBUG ?? "",
    PORT: String(PORT),
  };

  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
    process.stdout.write(`  [next] ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
    process.stderr.write(`  [next] ${d}`);
  });

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

/** The build's own id for a Server Action export — read from the manifest Next just wrote. */
function actionIdFor(exportedName: string): string {
  const manifestPath = path.join(".next", "server", "server-reference-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    node: Record<string, { workers: Record<string, { exportedName: string; filename: string }> }>;
  };
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    for (const worker of Object.values(entry.workers ?? {})) {
      if (worker.exportedName === exportedName) return id;
    }
  }
  throw new Error(
    `No action id for "${exportedName}" in ${manifestPath}. The build is stale or the export was renamed.`,
  );
}

/**
 * The `<form>` on the page whose hidden inputs include `name`=`value`, returned as
 * its full set of name/value pairs.
 *
 * A contact page renders many forms, and an earlier draft of this test picked the
 * first one it saw and submitted `scheduleActivity` while reporting on
 * `researchRecord`. Selecting by a field the target form uniquely carries — the
 * contact id it was rendered with — is what makes the replay verifiably the right
 * form rather than merely a form.
 */
/**
 * Undo HTML attribute escaping.
 *
 * `$ACTION_4:0` / `$ACTION_4:1` carry React's encoded action reference, which is
 * JSON — so the rendered attribute is full of `&quot;`. Replaying it verbatim sends
 * the escaped text and Next answers "Failed to find Server Action", which reads
 * exactly like a stale-build mismatch and is really just an undecoded value.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findFormWith(html: string, field: string, value: string): Map<string, string> | null {
  const candidates: Map<string, string>[] = [];
  for (const match of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)) {
    const inner = match[1];
    const fields = new Map<string, string>();
    for (const input of inner.matchAll(/<input\b[^>]*>/g)) {
      const tag = input[0];
      const name = tag.match(/\bname="([^"]*)"/)?.[1];
      if (name === undefined) continue;
      fields.set(decodeEntities(name), decodeEntities(tag.match(/\bvalue="([^"]*)"/)?.[1] ?? ""));
    }
    if (fields.get(field) !== value) continue;
    // `$ACTION_KEY` is emitted ONLY for a `useActionState` form, which is what
    // ResearchButton is. Without this the scheduleActivity form matches too — it
    // carries the same hidden contactId — and the suite reports on the wrong action
    // for the second time.
    if (!fields.has("$ACTION_KEY")) continue;
    candidates.push(fields);
  }
  if (candidates.length > 1) {
    throw new Error(
      `${candidates.length} useActionState forms carry ${field}=${value}. Refusing to guess ` +
        `which one is Research — narrow the selector instead of picking the first.`,
    );
  }
  return candidates[0] ?? null;
}

async function main(): Promise<void> {
  loadEnvFiles();
  assertDevDatabase();

  if (!existsSync(".next/required-server-files.json")) {
    throw new Error("No production build in .next — run `next build` first.");
  }

  let fx: Fixture | null = null;
  let server: ChildProcess | null = null;
  try {
    fx = await seedFixture();
    console.log(`Seeded tenant=${fx.tenantId} contact=${fx.contactId}`);
    server = await startServer();

    const cookie = `${(await import("../src/lib/session")).SESSION_COOKIE}=${fx.cookie}`;
    const contactUrl = `${BASE}/contacts/${fx.contactId}`;

    // ── 1. THE GET, which is what #515 already proves works ──────────────────
    const getRes = await fetch(contactUrl, {
      headers: { cookie },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const getLocation = getRes.headers.get("location") ?? "";
    const html = getRes.status === 200 ? await getRes.text() : "";

    check(
      "GET /contacts/<id> is not bounced to the platform console",
      !getLocation.includes("/platform"),
      `The owner escape hatch fired on the GET: redirected to ${getLocation}. The scope does ` +
        `not resolve even on a render, which is a DIFFERENT and larger failure than the one ` +
        `this test targets.`,
    );
    check("GET /contacts/<id> renders", getRes.status === 200, `status ${getRes.status} ${getLocation}`);

    // ── 2. THE POST — the shape that fails in production ─────────────────────
    //
    // MATCH THE EXACT ACTION, NEVER "THE FIRST FORM ON THE PAGE".
    //
    // The first draft of this test grabbed the first `$ACTION_ID_` in the HTML and
    // POSTed that. A contact page has many forms, so it submitted `scheduleActivity`
    // — which of course succeeded — and the suite printed PASS about code it never
    // executed. That is the same false confidence the #515 header warns about, and
    // it is worth more than a comment: an id is only usable if it IS researchRecord's.
    // THE RESEARCH FORM, REPLAYED FIELD FOR FIELD.
    //
    // `useActionState` does NOT render a `$ACTION_ID_<id>` input — it renders
    // `$ACTION_REF_<n>` plus `$ACTION_KEY`, and the action is resolved from those.
    // So matching on the action id finds nothing even though the form is right
    // there, which is why the earlier runs fell back to the header and 500'd.
    //
    // Replaying every hidden input of the real form is both simpler and stricter
    // than reconstructing the RSC protocol: it is byte-for-byte the POST a browser
    // with JavaScript disabled sends.
    // Fails loudly if the export is renamed or the build is stale, so a missing
    // form is never mistaken for a passing test.
    const actionId = actionIdFor("researchRecord");
    const researchForm = findFormWith(html, "contactId", fx.contactId);
    if (!researchForm) {
      throw new Error(
        "The Research form is not in the rendered HTML. Either isAiConfigured() is false " +
          "for the probe tenant (the seeded ANTHROPIC_API_KEY setting did not decrypt) or the " +
          "tab stopped rendering. Refusing to fall back to a synthetic request.",
      );
    }
    console.log(`  replaying form fields: ${[...researchForm.keys()].join(", ")} (id ${actionId})`);

    // The Research form carries ONE real field — the contact id — plus React's three
    // action markers. Anything else means a different form was picked up, which has
    // now happened twice: first `scheduleActivity` (matched on the shared hidden
    // contactId), then again after adding the `$ACTION_KEY` filter. A test that
    // silently drives the wrong action is worse than no test, so the field set is
    // pinned rather than trusted.
    const foreign = [...researchForm.keys()].filter(
      (k) => k !== "contactId" && !k.startsWith("$ACTION_"),
    );
    check(
      "the replayed form is Research's, carrying no foreign fields",
      foreign.length === 0,
      `unexpected fields: ${foreign.join(", ")} — this is not the ResearchButton form`,
    );

    // Built by hand rather than with `FormData`, so the request carries an explicit
    // Content-Length. Node's FormData streams the body chunked, and the action
    // decoder answered that with `Error: Connection closed.` — a 500 that looks like
    // an application fault but is purely a transport artefact of the test.
    const boundary = `----probe${crypto.randomBytes(8).toString("hex")}`;
    const parts: string[] = [];
    for (const [name, value] of researchForm) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      );
    }
    const multipart = Buffer.from(parts.join("") + `--${boundary}--\r\n`, "utf8");

    const before = serverOutput.length;
    const postRes = await fetch(contactUrl, {
      method: "POST",
      headers: {
        cookie,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(multipart.byteLength),
        // Next rejects/warns on a Server Action POST with no Origin ("Missing
        // `origin` header from a forwarded Server Actions request"). A browser
        // always sends one; omitting it tests a request no browser makes.
        origin: BASE,
      },
      body: multipart,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    const postBody = await postRes.text();
    const postLog = serverOutput.slice(before);

    console.log(
      `POST -> ${postRes.status} ${postRes.headers.get("content-type") ?? ""}\n` +
        `     body: ${JSON.stringify(postBody.slice(0, 400))}`,
    );

    // POSITIVE CONTROL: PROVE THE ACTION BODY ACTUALLY RAN.
    //
    // Without this the suite is trivially green. If the encoded arguments do not
    // decode, `formData.get("contactId")` is null and researchRecord returns
    // "Nothing to research." at its second line — BEFORE requireContactAccess, the
    // guard under test. A test that never reaches the guard reports "no
    // TenantScopeError" and means nothing by it, which is how the previous run
    // passed while submitting a different action entirely.
    // THE GATE ON EVERY OTHER ASSERTION. A 404/405 means Next never routed to the
    // action, so "no TenantScopeError" is a statement about a request that never ran
    // the code. The first two runs of this suite passed exactly that way.
    check(
      "the POST was routed to the Server Action (not 404/405)",
      postRes.status === 200,
      `status ${postRes.status}. Next did not dispatch the action, so nothing below is ` +
        `evidence of anything.`,
    );

    check(
      "the action received its contactId (it reached the guard at all)",
      !postBody.includes("Nothing to research."),
      `researchRecord returned "Nothing to research.", so the form arguments never ` +
        `decoded and requireContactAccess was never called. The assertions below are ` +
        `vacuous until this passes.`,
    );

    // ── 3. THE ASSERTIONS ────────────────────────────────────────────────────
    check(
      "the action did not refuse with TenantScopeError",
      !postLog.includes("TenantScopeError") && !postBody.includes("no resolvable workspace"),
      `THIS IS THE PRODUCTION FAILURE, REPRODUCED.\n       ` +
        `The Server Action could not resolve a workspace even though the GET above could.\n       ` +
        postLog.split("\n").filter((l) => l.includes("TenantScope") || l.includes("Error")).slice(0, 6).join("\n       "),
    );
    check(
      "the action did not 500",
      postRes.status < 500,
      `status ${postRes.status}. Body starts: ${postBody.slice(0, 200)}`,
    );

    // A durable second witness, in the shape production reported it.
    const { basePrisma } = await import("../src/lib/db");
    const logged = await basePrisma.errorLog.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }, message: { contains: "resolvable workspace" } },
      select: { message: true, context: true },
    });
    check(
      "no workspace-resolution error reached ErrorLog",
      logged.length === 0,
      logged.map((r) => `${r.context}: ${r.message.slice(0, 90)}`).join("\n       "),
    );
  } finally {
    if (server) killTree(server);
    await cleanup(fx);
  }

  console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
