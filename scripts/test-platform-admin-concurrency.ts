/**
 * CONCURRENT proof that the platform can never be left with zero active admins.
 *
 * The pure guard tests cannot detect this class of bug: each call to
 * canDisablePlatformAdmin is individually correct, and the race lives entirely in
 * the gap between reading the active count and committing the change. Only two
 * real transactions racing on a real database can show it.
 *
 * The specific defect this reproduces: with a per-ROW lock, admin A disabling B
 * and admin B disabling A lock DIFFERENT rows. Each transaction counts the other
 * as still active, both pass the guard, and both commit — leaving zero.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and cleans up
 * every row it creates.
 */
import bcrypt from "bcryptjs";
import { basePrisma } from "../src/lib/db";
import { withPlatformAdminLock } from "../src/lib/platformAdminLock";
import { canDisablePlatformAdmin } from "../src/lib/platformAdminGuards";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

/** The production disable path, minus auth and revalidation. */
async function disable(actorId: string, targetId: string): Promise<"done" | "refused"> {
  try {
    await withPlatformAdminLock(async ({ tx, otherActiveCount }) => {
      const gate = canDisablePlatformAdmin(actorId, targetId, await otherActiveCount(targetId));
      if (!gate.ok) throw new Error(gate.error);
      await tx.platformAdmin.update({
        where: { id: targetId },
        data: { disabledAt: new Date(), sessionVersion: { increment: 1 } },
      });
    });
    return "done";
  } catch {
    return "refused";
  }
}

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
    throw new Error(
      `refuses to run: expected NODE_ENV=test and a *_test database, got NODE_ENV=${process.env.NODE_ENV} db=${dbName || "(none)"}.`,
    );
  }

  const hash = await bcrypt.hash("concurrency-proof-pw-1", 4);
  const mk = (tag: string) =>
    basePrisma.platformAdmin.create({
      data: { name: `Admin ${tag}`, email: `${tag}-${SFX}@proof.invalid`, passwordHash: hash },
    });

  // Isolate from any pre-existing admins: this database is a throwaway, but the
  // count guard is global, so leftovers would change the arithmetic.
  const preexisting = await basePrisma.platformAdmin.count({ where: { disabledAt: null } });
  if (preexisting > 0) {
    console.log(`  note: ${preexisting} pre-existing active admin(s); disabling for the proof`);
    await basePrisma.platformAdmin.updateMany({
      where: { disabledAt: null },
      data: { disabledAt: new Date() },
    });
  }

  try {
    // ── The race: two active admins, each disabling the other simultaneously.
    const a = await mk("a");
    const b = await mk("b");

    const [ra, rb] = await Promise.all([disable(a.id, b.id), disable(b.id, a.id)]);
    const active = await basePrisma.platformAdmin.count({
      where: { id: { in: [a.id, b.id] }, disabledAt: null },
    });

    console.log(`  (A→disable B: ${ra}, B→disable A: ${rb}, active remaining: ${active})`);
    check("concurrent mutual disable leaves at least one active admin", active >= 1);
    check("exactly one of the two concurrent disables succeeded", [ra, rb].filter((r) => r === "done").length === 1);

    // ── The single-admin case still refuses.
    const soloResult = await disable(a.id, b.id);
    const stillActive = await basePrisma.platformAdmin.count({
      where: { id: { in: [a.id, b.id] }, disabledAt: null },
    });
    check("disabling the last active admin is refused", soloResult === "refused" || stillActive >= 1);

    // ── Self-disable is refused even with others active.
    await basePrisma.platformAdmin.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { disabledAt: null },
    });
    check("cannot disable yourself", (await disable(a.id, a.id)) === "refused");

    await basePrisma.platformAdmin.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  } finally {
    await basePrisma.platformAdmin.deleteMany({ where: { email: { contains: `-${SFX}@proof.invalid` } } });
    if (preexisting > 0) {
      await basePrisma.platformAdmin.updateMany({
        where: { email: { not: { contains: "@proof.invalid" } } },
        data: { disabledAt: null },
      });
    }
  }

  console.log(`\nplatform-admin concurrency: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
