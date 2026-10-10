/**
 * THE AUDIT TRAIL A PERSON SEES AND EXPORTS IS THEIR WORKSPACE'S — WITH TENANT
 * ENFORCEMENT OFF.
 *
 * The audit screen and /api/audit/export read "AuditEvent" through the bypass
 * client, so the workspace is in those queries only because somebody wrote it
 * there. It was written behind `NOT tenantEnforcing() OR …`: with enforcement
 * off — the default everywhere but production, and the rollback mode — the
 * predicate was always true, and anyone holding `audit.view` or `audit.export`
 * read every workspace's trail.
 *
 * So this asks the real export route and the real page, as a real signed-in
 * member of each of two workspaces, in both modes, off first:
 *
 *   - A's export and A's screen hold A's events and none of B's, and the other
 *     way round;
 *   - the screen's Event and Entity filters offer only what A's own events
 *     contain — an unscoped DISTINCT names what other workspaces have been doing;
 *   - no filter in the query string can reach across (`q`, `actor`);
 *   - an event with NO workspace is in nobody's list or export — the policy
 *     lib/auditScope.ts states, pinned here;
 *   - a sign-in that resolves to no workspace is given nothing at all.
 *
 * The page is not rendered: it is called, its queries run, and the element tree
 * it returns is read for what it would have shown.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Audit
 * events are append-only, so the handful it writes stay behind, in workspaces
 * that are deleted when it finishes.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { signFreshSession } from "../src/lib/session";
import { GET } from "../src/app/api/audit/export/route";
import AuditPage from "../src/app/(app)/audit/page";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";
import { runAsSession } from "./harness/actingSession";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

/** One event, written the way lib/audit.ts writes it, owned by exactly who the fixture says. */
async function plant(owner: "a" | "b" | "none", tenantId: string | null, actorUserId: string | null, summary: string) {
  await basePrisma.$executeRaw`
    INSERT INTO "AuditEvent" ("id", "tenantId", "actorUserId", "actorName", "actorType", "eventType", "entityType", "entityId", "summary", "source")
    VALUES (${crypto.randomUUID()}, ${tenantId}, ${actorUserId}, ${"Audit probe"}, ${actorUserId ? "user" : "system"},
      ${`probe.${owner}.${SFX}`}, ${`Probe-${owner}-${SFX}`}, ${`probe_${SFX}`}, ${summary}, ${"test"})
  `;
}

/** Every string anywhere in an element tree: what the screen would show, without rendering it. */
function textOf(node: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) for (const child of node) textOf(child, seen, out);
  else if (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) for (const value of Object.values(props)) textOf(value, seen, out);
  }
  return out;
}

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`ax${SFX}`);
  const { a, b } = fixture;
  // Somebody who may export but belongs to no workspace: a global owner with no
  // membership and no workspace in their session.
  const drifter = { id: crypto.randomUUID(), name: `Drifter ${SFX}`, email: `drifter.${SFX}@harness.invalid`, role: "owner" };
  await basePrisma.$executeRaw`
    INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "sessionVersion")
    VALUES (${drifter.id}, ${drifter.name}, ${drifter.email}, ${"not-a-real-hash"}, ${drifter.role}, 0)
  `;
  const drifterSession = { cookieValue: await signFreshSession({ ...drifter, grants: "", sessionVersion: 0 }, 60), label: "no workspace" };

  const mark = { a: `AUDIT-OF-A-${SFX}`, b: `AUDIT-OF-B-${SFX}`, none: `AUDIT-OF-NOBODY-${SFX}` };
  await plant("a", a.tenantId, a.memberUserId, `${mark.a} one`);
  await plant("a", a.tenantId, a.memberUserId, `${mark.a} two`);
  await plant("b", b.tenantId, b.memberUserId, `${mark.b} one`);
  await plant("b", b.tenantId, b.memberUserId, `${mark.b} two`);
  await plant("none", null, null, `${mark.none} one`);

  type Run = <T>(work: () => Promise<T>) => Promise<T>;
  /** The CSV the route answered with: its status, and how many rows carry each marker. */
  const exported = async (run: Run, query = "") => {
    const response = await run(() => GET(new NextRequest(`http://localhost/api/audit/export${query}`)));
    const body = await response.text();
    const count = (marker: string) => body.split("\n").filter((line) => line.includes(marker)).length;
    return { status: response.status, a: count(mark.a), b: count(mark.b), none: count(mark.none), rows: Math.max(0, body.split("\n").length - 1) };
  };
  /** What the audit screen would show: events by marker, and what its two filters offer. */
  const screen = async (run: Run) => {
    const text = textOf(await run(() => AuditPage({ searchParams: Promise.resolve({ q: SFX }) })));
    const count = (marker: string) => text.filter((piece) => piece.includes(marker)).length;
    const offers = (owner: string) => text.includes(`probe.${owner}.${SFX}`) || text.includes(`Probe-${owner}-${SFX}`);
    return { a: count(mark.a), b: count(mark.b), none: count(mark.none), offersA: offers("a"), offersB: offers("b"), offersNone: offers("none") };
  };

  try {
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nThe audit trail, two workspaces — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const staffOfA: Run = (work) => actAsStaff(a, work, { enforcing });
      const staffOfB: Run = (work) => actAsStaff(b, work, { enforcing });
      const nobody: Run = (work) => runAsSession(drifterSession, work);

      // ── the export ────────────────────────────────────────────────────────
      const fromA = await exported(staffOfA);
      check("A's export is served", fromA.status === 200, `status ${fromA.status}`);
      check("…and holds A's events", fromA.a === 2, JSON.stringify(fromA));
      check("…none of B's", fromA.b === 0, JSON.stringify(fromA));
      check("…and not the event that has no workspace: it is nobody's", fromA.none === 0, JSON.stringify(fromA));

      const fromB = await exported(staffOfB);
      check("B's export holds B's events and none of A's", fromB.status === 200 && fromB.b === 2 && fromB.a === 0 && fromB.none === 0, JSON.stringify(fromB));

      // A filter narrows; it must never be a way across.
      const searched = await exported(staffOfA, `?q=${encodeURIComponent(mark.b)}`);
      check("searching A's export for B's wording finds nothing", searched.status === 200 && searched.rows === 0, JSON.stringify(searched));
      const byActor = await exported(staffOfA, `?actor=${encodeURIComponent(b.memberUserId)}`);
      check("filtering A's export by one of B's people finds nothing", byActor.status === 200 && byActor.rows === 0, JSON.stringify(byActor));
      const ownSearch = await exported(staffOfA, `?q=${encodeURIComponent(`${mark.a} two`)}`);
      check("…while A's own search still narrows A's events", ownSearch.a === 1 && ownSearch.rows === 1, JSON.stringify(ownSearch));

      // No workspace, no events — not even the unowned ones the old clause matched NULL to NULL for.
      const adrift = await exported(nobody, `?q=${SFX}`);
      check("a sign-in with no workspace is given no events at all", adrift.a === 0 && adrift.b === 0 && adrift.none === 0, JSON.stringify(adrift));

      // ── the screen the export is linked from ──────────────────────────────
      const seenByA = await screen(staffOfA);
      check("A's audit screen lists A's events", seenByA.a === 2, JSON.stringify(seenByA));
      check("…none of B's, and not the event with no workspace", seenByA.b === 0 && seenByA.none === 0, JSON.stringify(seenByA));
      check("…and its Event and Entity filters offer only what A's own events contain", seenByA.offersA && !seenByA.offersB && !seenByA.offersNone, JSON.stringify(seenByA));
      const seenByB = await screen(staffOfB);
      check("B's audit screen lists B's events and none of A's", seenByB.b === 2 && seenByB.a === 0 && seenByB.none === 0 && seenByB.offersB && !seenByB.offersA, JSON.stringify(seenByB));
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${drifter.id}`.catch(() => 0);
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
