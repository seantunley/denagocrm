/**
 * SIGNING ENGAGEMENT — reports that arrive together cannot undo each other.
 *
 * What makes this a database test: "the figures only ever go up" is a claim
 * about two reports from the signing page landing at the same moment, and no
 * reading of the code settles it. Read the row, take the larger figure, write
 * it back — every line of that is correct, and an older report that finishes
 * last still writes its smaller figure over the newer one. It is settled by
 * the database raising each figure in one statement, and this fires real
 * overlapping reports at a real row to hold it there.
 *
 * It also proves the control: the read-then-write shape, run the same way,
 * really does lose updates here — so a pass above is not a test that could
 * never fail.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and
 * removes the workspace and rows it creates.
 */
import { createHash, randomBytes } from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { applyViewReport } from "../src/lib/signing/viewReport";
import { MAX_VIEW_SECONDS, mergeViewReport } from "../src/lib/signing/viewAnalytics";

const SFX = Math.random().toString(16).slice(2, 10);
const tenantA = `t_view_a_${SFX}`;
const tenantB = `t_view_b_${SFX}`;
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

async function cleanup() {
  // Sittings and recipients go with their request; requests are removed by workspace.
  await basePrisma.signatureRequest.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
}

/** A signing request with one recipient and one sitting, in `tenantId`. */
async function sitting(tenantId: string, label: string) {
  const request = await basePrisma.signatureRequest.create({ data: { tenantId, title: `View probe ${label} ${SFX}`, status: "sent", sentAt: new Date() } });
  const recipient = await basePrisma.signatureRecipient.create({
    data: { tenantId, requestId: request.id, name: `Signer ${label}`, status: "sent", token: createHash("sha256").update(randomBytes(32)).digest("hex") },
  });
  const view = await basePrisma.signatureView.create({ data: { tenantId, requestId: request.id, recipientId: recipient.id } });
  return { id: view.id, tenantId, recipientId: recipient.id, requestId: request.id };
}
const read = (id: string) => basePrisma.signatureView.findUniqueOrThrow({ where: { id }, select: { seconds: true, maxPage: true } });
const shuffled = <T,>(list: T[]): T[] => list.map((v) => [Math.random(), v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

async function main() {
  guardEnvironment();
  for (const [id, name] of [[tenantA, "Acme Carts"], [tenantB, "Other Motors"]]) {
    await basePrisma.tenant.create({ data: { id, name, slug: id, active: true } });
  }

  try {
    console.log("\n== reports that arrive together");
    const a = await sitting(tenantA, "A");
    // 60 reports, every figure from 1 to 60, in a random order, all at once: whichever lands last, the row must hold 60.
    const reports = shuffled(Array.from({ length: 60 }, (_, i) => ({ seconds: i + 1, page: (i % 12) + 1 })));
    const results = await Promise.all(reports.map((report) => applyViewReport(basePrisma, a, report)));
    check("every report found its sitting", results.every(Boolean));
    const after = await read(a.id);
    check("the time in view is the LARGEST reported, whatever order they landed in", after.seconds === 60, `${after.seconds}s`);
    check("the furthest page is the furthest reported", after.maxPage === 12, `page ${after.maxPage}`);

    // Again and again, so that a rare interleaving is not left to chance.
    let worst = 60;
    for (let round = 0; round < 15; round++) {
      await basePrisma.signatureView.update({ where: { id: a.id }, data: { seconds: 0, maxPage: 1 } });
      await Promise.all(shuffled(reports).map((report) => applyViewReport(basePrisma, a, report)));
      const now = await read(a.id);
      worst = Math.min(worst, now.seconds, now.maxPage === 12 ? 60 : 0);
    }
    check("and the same over 15 more rounds of 60 overlapping reports", worst === 60, `lowest result ${worst}`);

    console.log("\n== late, repeated and silly reports");
    await applyViewReport(basePrisma, a, { seconds: 5, page: 1 });
    check("a late, smaller report changes nothing", (await read(a.id)).seconds === 60 && (await read(a.id)).maxPage === 12);
    await applyViewReport(basePrisma, a, { seconds: 9e9, page: "12" });
    const capped = await read(a.id);
    check("a huge figure stops at the ceiling; a page that is not a number is ignored", capped.seconds === MAX_VIEW_SECONDS && capped.maxPage === 12, `${capped.seconds}s, page ${capped.maxPage}`);

    console.log("\n== only through the link that opened it");
    const b = await sitting(tenantB, "B");
    const wrongLink = await applyViewReport(basePrisma, { id: b.id, tenantId: tenantB, recipientId: a.recipientId, requestId: a.requestId }, { seconds: 900, page: 9 });
    const untouched = await read(b.id);
    check("another recipient's link cannot change a sitting, even knowing its id", wrongLink === false && untouched.seconds === 0 && untouched.maxPage === 1);
    // This client can see every workspace (it bypasses the policy), so only the writer's own WHERE stands in the way.
    const wrongWorkspace = await applyViewReport(basePrisma, { ...b, tenantId: tenantA }, { seconds: 900, page: 9 });
    const stillUntouched = await read(b.id);
    check("every id right but the workspace wrong: nothing changes, even on a client that sees all workspaces", wrongWorkspace === false && stillUntouched.seconds === 0 && stillUntouched.maxPage === 1);
    check("a sitting that does not exist is reported as such", (await applyViewReport(basePrisma, { ...a, id: "no-such-sitting" }, { seconds: 1 })) === false);

    console.log("\n== the control: reading, then writing, DOES lose updates here");
    // The shape this replaced. If it could not fail against this database, the passes above would prove nothing.
    const naive = async (report: { seconds: number; page: number }) => {
      const current = await read(a.id);
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
      await basePrisma.signatureView.update({ where: { id: a.id }, data: mergeViewReport(current, report) });
    };
    let lost = false;
    for (let round = 0; round < 10 && !lost; round++) {
      await basePrisma.signatureView.update({ where: { id: a.id }, data: { seconds: 0, maxPage: 1 } });
      await Promise.all(shuffled(reports).map(naive));
      lost = (await read(a.id)).seconds < 60;
    }
    check("read-then-write ends below the largest report at least once in 10 rounds", lost);
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
