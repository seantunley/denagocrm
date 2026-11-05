import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * Review of #1007, against real PostgreSQL: two (and more) triage preparations finishing at the same moment for the
 * same person leave exactly ONE open run, and never touch another person's. Before replaceTriageRun, close-then-create
 * were two writes, and two tabs could each close the old run before either made theirs — two open runs.
 */
async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !target.pathname.endsWith("_test")) {
    throw new Error("Triage integration checks require NODE_ENV=test and a local disposable *_test database.");
  }
  const { basePrisma } = await import("../src/lib/db");
  const { seedTwoTenants, teardown } = await import("./harness/seed");
  const { replaceTriageRun } = await import("../src/lib/triageStore");
  const fixture = await seedTwoTenants(`triage_${randomUUID().slice(0, 8)}`);
  const { a, b } = fixture;
  const details = { preparedAt: new Date().toISOString(), items: [] };
  const openRuns = (tenantId: string, userId: string) =>
    basePrisma.assistantTask.count({ where: { tenantId, userId, kind: "triage", status: "open" } });
  try {
    // An earlier run, and someone else's (another person here, another workspace's member there).
    await replaceTriageRun(a.tenantId, a.memberUserId, "earlier", details);
    await replaceTriageRun(a.tenantId, a.ownerUserId, "a colleague's", details);
    await replaceTriageRun(b.tenantId, b.memberUserId, "another workspace", details);

    // Six tabs press Prepare at once.
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => replaceTriageRun(a.tenantId, a.memberUserId, `tab ${i}`, details)));
    assert.equal(new Set(ids).size, 6, "each preparation made its own run");
    assert.equal(await openRuns(a.tenantId, a.memberUserId), 1, "exactly one open run for that person");
    const open = await basePrisma.assistantTask.findFirstOrThrow({ where: { tenantId: a.tenantId, userId: a.memberUserId, kind: "triage", status: "open" }, select: { id: true } });
    assert.ok(ids.includes(open.id), "and it is one of theirs");
    assert.equal(await basePrisma.assistantTask.count({ where: { tenantId: a.tenantId, userId: a.memberUserId, kind: "triage", status: "closed" } }), 6, "the earlier one and five of the six are closed");

    assert.equal(await openRuns(a.tenantId, a.ownerUserId), 1, "a colleague's run is untouched");
    assert.equal(await openRuns(b.tenantId, b.memberUserId), 1, "another workspace's run is untouched");
    console.log("triage prepare: one open run per person under concurrent preparation ✓");
  } finally {
    await basePrisma.assistantTask.deleteMany({ where: { kind: "triage", tenantId: { in: [a.tenantId, b.tenantId] } } });
    await teardown(fixture);
    await basePrisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
