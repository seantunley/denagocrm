/**
 * CONCURRENT proof that two editors cannot corrupt a checklist's revision
 * snapshot.
 *
 * The pure tests cannot detect this class of bug. Every individual statement in
 * saveChecklistTemplate is correct; the defect lived entirely in the gap between
 * reading the template and writing it:
 *
 *   Editor A                     Editor B
 *   ────────                     ────────
 *   read → version 1
 *                                read → version 1
 *   set version 2
 *                                set version 2          ← no check, so it "wins"
 *   write A's items
 *                                write B's items        ← live list is now B's
 *   create revision 2 = A
 *                                upsert revision 2      ← already there, no-op
 *
 * The template ends up holding B's items while the immutable revision 2 holds
 * A's. A run stamped version 2 then DISPLAYS one checklist and SYNCS against a
 * different set of authoritative questions — exactly what a revision snapshot
 * exists to make impossible, and silent at every step.
 *
 * Only two real writes racing on a real database can show it, which is why this
 * is a script and not a unit test. Same shape as
 * test-conversation-draft-concurrency.ts and test-platform-admin-concurrency.ts.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { claimTemplateVersion } from "../src/lib/checklists/templateVersion";

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
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Refusing to run outside NODE_ENV=test");
  }
  // The database name must SAY it is a test database. This script writes and
  // deletes rows; "probably not production" is not good enough.
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = {
  tenant: `t_${SFX}`,
  template: `tpl_${SFX}`,
};

async function seed() {
  await basePrisma.tenant.create({
    data: { id: ids.tenant, name: `Checklist concurrency ${SFX}`, slug: `checklist-concurrency-${SFX}`, active: true },
  });
  await basePrisma.checklistTemplate.create({
    data: {
      id: ids.template,
      tenantId: ids.tenant,
      host: "quote.delivery",
      name: `Handover ${SFX}`,
      version: 1,
      sortOrder: 0,
    },
  });
}

async function cleanup() {
  await basePrisma.checklistTemplateRevision.deleteMany({ where: { templateId: ids.template } });
  await basePrisma.checklistItem.deleteMany({ where: { templateId: ids.template } });
  await basePrisma.checklistTemplate.deleteMany({ where: { id: ids.template } });
  await basePrisma.tenant.deleteMany({ where: { id: ids.tenant } });
}

function meta(name: string) {
  return { name, description: null, active: true, sortOrder: 0 };
}

/**
 * One editor's save, as the action performs it: claim the version, then write
 * the revision — both inside ONE transaction, which is what makes the claim
 * meaningful. A claim that loses must leave nothing behind.
 */
async function save(editor: string, fromVersion: number) {
  try {
    return await basePrisma.$transaction(async (tx) => {
      const claimed = await claimTemplateVersion(tx, {
        tenantId: ids.tenant,
        templateId: ids.template,
        fromVersion,
        bump: true,
        meta: meta(`Handover — ${editor}`),
      });
      if (!claimed) return { ok: false as const, editor };
      await tx.checklistTemplateRevision.create({
        data: {
          tenantId: ids.tenant,
          templateId: ids.template,
          version: fromVersion + 1,
          items: [{ label: `${editor}'s step` }],
        },
      });
      return { ok: true as const, editor };
    });
  } catch (error) {
    // A unique-constraint violation here would mean two transactions both
    // believed they held the version. Reported as a failure to claim so the
    // assertions below can tell "refused cleanly" from "both got through".
    return { ok: false as const, editor, threw: String(error).slice(0, 120) };
  }
}

async function state() {
  const [template, revisions] = await Promise.all([
    basePrisma.checklistTemplate.findUnique({
      where: { id: ids.template },
      select: { name: true, version: true },
    }),
    basePrisma.checklistTemplateRevision.findMany({
      where: { templateId: ids.template },
      orderBy: { version: "asc" },
      select: { version: true, items: true },
    }),
  ]);
  return { template, revisions };
}

async function main() {
  guardEnvironment();
  await seed();

  // ── 1. THE RACE ───────────────────────────────────────────────────────────
  //
  // Both saves are issued without awaiting the first, so they reach the database
  // together. Both were computed against version 1. Exactly one must win.
  const [a, b] = await Promise.all([save("A", 1), save("B", 1)]);

  const winners = [a, b].filter((r) => r.ok).length;
  check("exactly one concurrent save succeeds", winners === 1, `${winners} succeeded`);
  const loser = [a, b].find((r) => !r.ok);
  check(
    "the loser is refused rather than throwing a constraint error",
    Boolean(loser) && !("threw" in (loser ?? {})),
    "threw" in (loser ?? {}) ? String((loser as { threw?: string }).threw) : "",
  );

  // ── 2. THE SNAPSHOT MATCHES THE LIST ──────────────────────────────────────
  //
  // The whole point. Whichever editor won, the revision stored at the template's
  // current version must be THAT editor's items — never the other's.
  const after = await state();
  const winner = a.ok ? "A" : "B";
  check("the version advanced exactly once", after.template?.version === 2, `version ${after.template?.version}`);
  check(
    "the live template belongs to the save that won",
    after.template?.name === `Handover — ${winner}`,
    `stored "${after.template?.name}", expected "Handover — ${winner}"`,
  );
  check("exactly one revision was written", after.revisions.length === 1, `${after.revisions.length} revisions`);
  const snapshot = after.revisions[0];
  check(
    "the revision snapshot is the winner's items, not the loser's",
    JSON.stringify(snapshot?.items) === JSON.stringify([{ label: `${winner}'s step` }]),
    JSON.stringify(snapshot?.items),
  );

  // ── 3. THE LOSER'S RETRY, ONCE IT HAS RELOADED ────────────────────────────
  //
  // A refusal must be recoverable, not a dead end: reloading gives the current
  // version, and the save then succeeds and takes the next revision.
  const retry = await save("B-again", after.template?.version ?? 2);
  check("a save recomputed against the current version succeeds", retry.ok);
  const final = await state();
  check("and it takes the next version", final.template?.version === 3, `version ${final.template?.version}`);
  check("leaving one revision per version", final.revisions.length === 2, `${final.revisions.length} revisions`);

  // ── 4. A STALE SAVE STAYS REFUSED ─────────────────────────────────────────
  //
  // Version 1 is long gone. A save still holding it must never write again, no
  // matter how much later it arrives.
  const stale = await save("ghost", 1);
  check("a save computed against a superseded version is refused", !stale.ok);
  const untouched = await state();
  check(
    "and it changed nothing",
    untouched.template?.version === 3 && untouched.revisions.length === 2,
    `version ${untouched.template?.version}, ${untouched.revisions.length} revisions`,
  );
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
