/**
 * A TRANSACTION ON THE EVERYDAY CLIENT HAS TO BE ONE.
 *
 * `prisma.$transaction(async (tx) => …)` is how most of this codebase says "these
 * changes belong together": 63 call sites — signing, deliveries, stock, leads,
 * job cards, test drives. For as long as the scoped client has existed it was
 * not a transaction. Every operation on `tx` was wrapped in a transaction of
 * its own and committed as it ran, so a refusal part-way left the earlier steps
 * in place, and a row lock taken on `tx` was gone before the next line.
 *
 * Nothing saw it, because nothing asked a real database. The tests around those
 * call sites read source or drive fakes, and a source test cannot tell a
 * transaction from something that is spelled like one. So this asks:
 *
 *   - does a throw undo what `tx` wrote — through a model and through raw SQL;
 *   - is a row lock, and an advisory lock, still held on the next line;
 *   - does a later statement on `tx` see an earlier one;
 *   - and is it still the SCOPED client inside: one workspace's rows, trashed
 *     rows hidden, creates stamped, the workspace setting made on the
 *     transaction's own connection, failing closed with no scope.
 *
 * The array form (`$transaction([a, b])`) cannot be made atomic on either
 * client — its elements are bound to the client that made them before the
 * transaction exists — so it is refused, and this checks that too.
 *
 * Row-level security itself is proved under a restricted role in
 * scripts/test-rls-restricted.ts; this connects as the owner, which bypasses it.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma, prisma } from "../src/lib/db";
import { reorderPipelineStages } from "../src/lib/pipelines";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";

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

class Undo extends Error {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a rejected promise said, or null if it resolved. */
const rejection = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => String((error as Error)?.message ?? error));

const tA = `stx_a_${SFX}`;
const tB = `stx_b_${SFX}`;
const ids = { userA: `stx_ua_${SFX}`, userB: `stx_ub_${SFX}`, a1: `stx_a1_${SFX}`, a2: `stx_a2_${SFX}`, trashed: `stx_at_${SFX}`, b1: `stx_b1_${SFX}` };
const pipelineId = `stx_p_${SFX}`;
const stageIds = [`stx_s1_${SFX}`, `stx_s2_${SFX}`, `stx_s3_${SFX}`];

async function main() {
  guardEnvironment();

  await basePrisma.tenant.createMany({ data: [tA, tB].map((id) => ({ id, name: `Scoped tx ${id}`, slug: id, active: true })) });
  await basePrisma.user.createMany({
    data: [
      { id: ids.userA, name: "A", email: `stx-a-${SFX}@example.test`, passwordHash: "x", role: "sales", tenantId: tA },
      { id: ids.userB, name: "B", email: `stx-b-${SFX}@example.test`, passwordHash: "x", role: "sales", tenantId: tB },
    ],
  });
  await basePrisma.contact.createMany({
    data: [
      { id: ids.a1, firstName: "Before", lastName: "one", createdById: ids.userA, tenantId: tA },
      { id: ids.a2, firstName: "Before", lastName: "two", createdById: ids.userA, tenantId: tA },
      { id: ids.trashed, firstName: "Before", lastName: "trashed", createdById: ids.userA, tenantId: tA, deletedAt: new Date() },
      { id: ids.b1, firstName: "Before", lastName: "theirs", createdById: ids.userB, tenantId: tB },
    ],
  });

  const nameOf = async (id: string) => (await basePrisma.contact.findUniqueOrThrow({ where: { id }, select: { firstName: true } })).firstName;
  const reset = () => basePrisma.contact.updateMany({ where: { id: { in: Object.values(ids) } }, data: { firstName: "Before" } });
  const asA = <T>(work: () => Promise<T>) => runInTenantScope({ tenantId: tA, system: false }, work);
  const asB = <T>(work: () => Promise<T>) => runInTenantScope({ tenantId: tB, system: false }, work);
  /** Can ANOTHER connection lock this row right now? */
  const rowFromElsewhere = async (id: string) => {
    try {
      await basePrisma.$transaction(async (other) => {
        await other.$queryRaw`SELECT id FROM "Contact" WHERE id = ${id} FOR UPDATE NOWAIT`;
      });
      return "free";
    } catch (error) {
      return /55P03|could not obtain lock/.test(String(error)) ? "held" : `error: ${String(error).slice(0, 120)}`;
    }
  };
  const advisoryFromElsewhere = async (key: string) => {
    const rows = await basePrisma.$transaction((other) => other.$queryRaw<Array<{ got: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})::bigint) AS got`);
    return rows[0]?.got ? "free" : "held";
  };
  const settings = (tx: { $queryRaw: typeof basePrisma.$queryRaw }) =>
    tx.$queryRaw<Array<{ tenant: string | null; bypass: string | null }>>`
      SELECT nullif(current_setting('app.current_tenant', true), '') AS tenant, nullif(current_setting('app.bypass_rls', true), '') AS bypass
    `.then((rows) => rows[0]);

  for (const enforcing of [false, true]) {
    __setTenantEnforcingForTests(enforcing);
    console.log(`\nA transaction on the scoped client — tenant enforcement ${enforcing ? "ON" : "off"}`);

    // ── all or nothing ──────────────────────────────────────────────────────
    await reset();
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Written" } });
      throw new Undo();
    })).catch((error) => { if (!(error instanceof Undo)) throw error; });
    check("a throw undoes a write made through a model", (await nameOf(ids.a1)) === "Before", await nameOf(ids.a1));

    await reset();
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "Contact" SET "firstName" = 'Written' WHERE id = ${ids.a1} AND "tenantId" = ${tA}`;
      throw new Undo();
    })).catch((error) => { if (!(error instanceof Undo)) throw error; });
    check("a throw undoes a write made through raw SQL", (await nameOf(ids.a1)) === "Before", await nameOf(ids.a1));

    await reset();
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "First" } });
      await tx.contact.updateMany({ where: { id: ids.a2 }, data: { firstName: "Second" } });
      // A failure in the DATABASE, not a throw of ours: a duplicate primary key.
      await tx.contact.create({ data: { id: ids.a1, firstName: "Duplicate", lastName: "key", createdById: ids.userA } });
    })).catch(() => {});
    check("a statement the database refuses undoes the ones before it", (await nameOf(ids.a1)) === "Before" && (await nameOf(ids.a2)) === "Before", `${await nameOf(ids.a1)} / ${await nameOf(ids.a2)}`);

    await reset();
    const returned = await asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Kept" } });
      await tx.$executeRaw`UPDATE "Contact" SET "firstName" = 'Kept' WHERE id = ${ids.a2} AND "tenantId" = ${tA}`;
      return "the callback's value";
    }));
    check("when the callback resolves, everything is kept and its value comes back", returned === "the callback's value" && (await nameOf(ids.a1)) === "Kept" && (await nameOf(ids.a2)) === "Kept", `${returned} / ${await nameOf(ids.a1)} / ${await nameOf(ids.a2)}`);

    // ── locks ───────────────────────────────────────────────────────────────
    await reset();
    let whileHeld = "";
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${ids.a1} AND "tenantId" = ${tA} FOR UPDATE`;
      whileHeld = await rowFromElsewhere(ids.a1);
    }));
    check("SELECT … FOR UPDATE on tx holds the row until the transaction ends", whileHeld === "held", whileHeld);
    check("…and lets go of it then", (await rowFromElsewhere(ids.a1)) === "free");

    let afterUpdate = "";
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Held" } });
      afterUpdate = await rowFromElsewhere(ids.a1);
    }));
    check("a row updated on tx is held until the transaction ends", afterUpdate === "held", afterUpdate);

    const key = `stx-lock:${SFX}:${enforcing}`;
    let advisory = "";
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
      advisory = await advisoryFromElsewhere(key);
    }));
    check("an advisory lock taken on tx is held until the transaction ends", advisory === "held", advisory);
    check("…and released then", (await advisoryFromElsewhere(key)) === "free");

    // ── one transaction: later statements see earlier ones ──────────────────
    await reset();
    const seen = { model: "", raw: "", afterRaw: "", outside: "" };
    await asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Mine" } });
      seen.model = (await tx.contact.findFirst({ where: { id: ids.a1 }, select: { firstName: true } }))?.firstName ?? "";
      seen.raw = (await tx.$queryRaw<Array<{ firstName: string }>>`SELECT "firstName" FROM "Contact" WHERE id = ${ids.a1} AND "tenantId" = ${tA}`)[0]?.firstName ?? "";
      await tx.$executeRaw`UPDATE "Contact" SET "firstName" = 'RawMine' WHERE id = ${ids.a2} AND "tenantId" = ${tA}`;
      seen.afterRaw = (await tx.contact.findFirst({ where: { id: ids.a2 }, select: { firstName: true } }))?.firstName ?? "";
      seen.outside = await nameOf(ids.a1);
      throw new Undo();
    })).catch((error) => { if (!(error instanceof Undo)) throw error; });
    check("a later statement on tx sees an earlier one — model after model, raw after model, model after raw", seen.model === "Mine" && seen.raw === "Mine" && seen.afterRaw === "RawMine", JSON.stringify(seen));
    check("…and nobody else does until it commits", seen.outside === "Before", seen.outside);

    // ── still the scoped client inside ──────────────────────────────────────
    await reset();
    const inside = await asA(() => prisma.$transaction(async (tx) => {
      const set = await settings(tx);
      const visible = (await tx.contact.findMany({ where: { id: { in: [ids.a1, ids.b1] } }, select: { id: true } })).map((row) => row.id).sort();
      const trashedFound = await tx.contact.findFirst({ where: { id: ids.trashed }, select: { id: true } });
      const trashedTouched = (await tx.contact.updateMany({ where: { id: ids.trashed }, data: { firstName: "Touched" } })).count;
      const theirs = (await tx.contact.updateMany({ where: { id: ids.b1 }, data: { firstName: "Touched" } })).count;
      const created = await tx.contact.create({ data: { firstName: "Made", lastName: `inside ${SFX}`, createdById: ids.userA }, select: { id: true, tenantId: true } });
      return { set, visible, trashedFound, trashedTouched, theirs, created };
    }));
    check("a trashed row is not found or changed through tx", inside.trashedFound === null && inside.trashedTouched === 0 && (await nameOf(ids.trashed)) === "Before", JSON.stringify({ found: inside.trashedFound, touched: inside.trashedTouched }));
    if (enforcing) {
      check("the workspace setting is made on the transaction's own connection, and it is the tenant's — not the bypass", inside.set?.tenant === tA && inside.set.bypass !== "on", JSON.stringify(inside.set));
      check("tx reads one workspace's rows", inside.visible.join() === ids.a1, inside.visible.join());
      check("tx cannot change another workspace's row", inside.theirs === 0 && (await nameOf(ids.b1)) === "Before", `${inside.theirs} / ${await nameOf(ids.b1)}`);
      check("a row created on tx is stamped with the workspace", inside.created.tenantId === tA, String(inside.created.tenantId));
    } else {
      check("with enforcement off the transaction carries the bypass setting, as every other statement does", inside.set?.bypass === "on", JSON.stringify(inside.set));
      check("…and reads as it always has", inside.visible.length === 2, inside.visible.join());
    }
    await basePrisma.contact.deleteMany({ where: { id: inside.created.id } });

    // Two workspaces at once never share a connection's setting.
    const [seenA, seenB] = await Promise.all([
      asA(() => prisma.$transaction(async (tx) => { await sleep(120); return { set: await settings(tx), n: await tx.contact.count({ where: { id: { in: [ids.a1, ids.b1] } } }) }; })),
      asB(() => prisma.$transaction(async (tx) => { await sleep(60); return { set: await settings(tx), n: await tx.contact.count({ where: { id: { in: [ids.a1, ids.b1] } } }) }; })),
    ]);
    if (enforcing) {
      check("two workspaces' transactions at the same moment each keep their own setting", seenA.set?.tenant === tA && seenB.set?.tenant === tB && seenA.n === 1 && seenB.n === 1, JSON.stringify([seenA, seenB]));
    }

    // ── options reach the transaction ───────────────────────────────────────
    await reset();
    const late = await rejection(asA(() => prisma.$transaction(async (tx) => {
      await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Slow" } });
      await sleep(900);
      await tx.contact.count({ where: { id: ids.a1 } });
    }, { timeout: 300, maxWait: 5000 })));
    check("a transaction that overruns its timeout is undone, not half-kept", late !== null && (await nameOf(ids.a1)) === "Before", `${late?.slice(0, 80)} / ${await nameOf(ids.a1)}`);
  }

  // ── failing closed ────────────────────────────────────────────────────────
  console.log("\nWith enforcement ON and something missing");
  __setTenantEnforcingForTests(true);
  const noScope = await rejection(prisma.$transaction((tx) => tx.contact.findMany({ where: { id: ids.a1 } })));
  check("no workspace in scope: a tenant-owned read on tx is refused", noScope !== null && /tenant scope/i.test(noScope), String(noScope).slice(0, 120));
  const system = await runInTenantScope({ tenantId: null, system: true }, () =>
    prisma.$transaction(async (tx) => ({ set: await settings(tx), n: await tx.contact.count({ where: { id: { in: [ids.a1, ids.b1] } } }) })),
  );
  check("a trusted system scope sees every workspace, as it does outside a transaction", system.n === 2 && system.set?.bypass === "on", JSON.stringify(system));

  // ── the one write a transaction refuses ───────────────────────────────────
  // Creating a timeline message attaches it to its conversation and recomputes
  // that conversation's counters on ANOTHER connection, which then waits on the
  // transaction's own lock. Measured before the refusal existed: the whole
  // timeout, "Transaction already closed", nothing saved, and an empty
  // conversation left behind. No caller does it; this keeps the next one from
  // finding out the slow way.
  console.log("\nA timeline message inside a transaction");
  await reset();
  const messageStarted = Date.now();
  const message = await rejection(asA(() => prisma.$transaction(async (tx) => {
    await tx.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "With a message" } });
    await tx.communication.create({ data: { type: "note", direction: "internal", body: "inside a transaction", contactId: ids.a1, userId: ids.userA, tenantId: tA } });
  }, { timeout: 5000, maxWait: 5000 })));
  const messageTook = Date.now() - messageStarted;
  check("is refused, in words that say where to create it instead", message !== null && /after the transaction has committed/i.test(message), String(message).slice(0, 160));
  check("…at once, not after waiting out the transaction's own lock", messageTook < 3000, `${messageTook} ms`);
  const leftBehind = {
    contact: await nameOf(ids.a1),
    messages: await basePrisma.communication.count({ where: { contactId: ids.a1, tenantId: tA } }),
    conversations: await basePrisma.conversation.count({ where: { contactId: ids.a1, tenantId: tA } }),
  };
  check(
    "…and the refusal undoes the transaction: no message, no empty conversation, the contact as it was",
    leftBehind.contact === "Before" && leftBehind.messages === 0 && leftBehind.conversations === 0,
    JSON.stringify(leftBehind),
  );

  // ── the array form ────────────────────────────────────────────────────────
  console.log("\nThe array form");
  await reset();
  const scopedArray = await rejection(asA(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).$transaction([
      prisma.contact.updateMany({ where: { id: ids.a1 }, data: { firstName: "Array" } }),
      prisma.contact.updateMany({ where: { id: ids.a2 }, data: { firstName: "Array" } }),
    ]),
  ));
  check("is refused on the scoped client, in words that say what to do instead", scopedArray !== null && /callback/i.test(scopedArray), String(scopedArray).slice(0, 160));
  check("…before anything in it has run", (await nameOf(ids.a1)) === "Before" && (await nameOf(ids.a2)) === "Before", `${await nameOf(ids.a1)} / ${await nameOf(ids.a2)}`);
  const bypassArray = await rejection(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (basePrisma as any).$transaction([
      basePrisma.contact.updateMany({ where: { id: ids.a1, tenantId: tA }, data: { firstName: "Array" } }),
      basePrisma.contact.updateMany({ where: { id: ids.a2, tenantId: tA }, data: { firstName: "Array" } }),
    ]),
  );
  check("is refused on the bypass client too", bypassArray !== null && /callback/i.test(bypassArray), String(bypassArray).slice(0, 160));
  check("…before anything in it has run", (await nameOf(ids.a1)) === "Before" && (await nameOf(ids.a2)) === "Before", `${await nameOf(ids.a1)} / ${await nameOf(ids.a2)}`);

  // ── a caller that used the array form ─────────────────────────────────────
  // Reordering a pipeline's stages was two arrays of raw statements. Raw
  // statements on these clients are not deferred, so the first pass (park every
  // stage at 1000+) ran at once and `$transaction` then threw: the action
  // failed, the second pass never ran, and the stages stayed parked.
  console.log("\nReordering a pipeline's stages — it was two arrays of raw statements");
  await basePrisma.$executeRaw`INSERT INTO "SalesPipeline" ("id", "name", "tenantId") VALUES (${pipelineId}, ${`Scoped tx ${SFX}`}, ${tA})`;
  for (const [order, id] of stageIds.entries()) {
    await basePrisma.$executeRaw`INSERT INTO "PipelineStage" ("id", "name", "order", "pipelineId", "tenantId") VALUES (${id}, ${`Stage ${order}`}, ${order}, ${pipelineId}, ${tA})`;
  }
  const wanted = [stageIds[2], stageIds[0], stageIds[1]];
  const reorder = await rejection(asA(() => reorderPipelineStages(pipelineId, wanted)));
  const orders = await basePrisma.$queryRaw<Array<{ id: string; order: number }>>`SELECT "id", "order" FROM "PipelineStage" WHERE "pipelineId" = ${pipelineId} ORDER BY "order"`;
  check("it succeeds", reorder === null, String(reorder).slice(0, 160));
  check("and the stages are numbered 0, 1, 2 in the order asked for — not left parked at 1000", orders.map((row) => row.id).join() === wanted.join() && orders.map((row) => row.order).join() === "0,1,2", JSON.stringify(orders.map((row) => row.order)));
  const other = await rejection(asB(() => reorderPipelineStages(pipelineId, stageIds)));
  check("another workspace cannot reorder it", other !== null && (await basePrisma.$queryRaw<Array<{ order: number }>>`SELECT "order" FROM "PipelineStage" WHERE "pipelineId" = ${pipelineId} ORDER BY "order"`).map((row) => row.order).join() === "0,1,2", String(other).slice(0, 120));

  // ── the bypass client's callback form, which was always real ──────────────
  console.log("\nThe bypass client, unchanged");
  await reset();
  await basePrisma.$transaction(async (tx) => {
    await tx.contact.updateMany({ where: { id: ids.a1, tenantId: tA }, data: { firstName: "Written" } });
    throw new Undo();
  }).catch((error) => { if (!(error instanceof Undo)) throw error; });
  check("its callback form still undoes on a throw", (await nameOf(ids.a1)) === "Before", await nameOf(ids.a1));
  const everything = await basePrisma.$transaction(async (tx) => ({ set: await settings(tx), n: await tx.contact.count({ where: { id: { in: [ids.a1, ids.b1, ids.trashed] } } }) }));
  check("…and still sees every workspace and trashed rows", everything.n === 3 && everything.set?.bypass === "on", JSON.stringify(everything));

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    console.error(error);
    failed++;
  })
  .finally(async () => {
    __setTenantEnforcingForTests(null);
    await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "pipelineId" = ${pipelineId}`.catch(() => {});
    await basePrisma.$executeRaw`DELETE FROM "SalesPipeline" WHERE "id" = ${pipelineId}`.catch(() => {});
    await basePrisma.contact.deleteMany({ where: { OR: [{ id: { in: Object.values(ids) } }, { lastName: `inside ${SFX}` }] } }).catch(() => {});
    await basePrisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB] } } }).catch(() => {});
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } }).catch(() => {});
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
