/**
 * A SIGNING WORKFLOW BELONGS TO ONE WORKSPACE — WITH TENANT ENFORCEMENT OFF.
 *
 * The workflow editor and its four actions are the owner's, and that guard was
 * all they had. They looked a workflow up by the id the browser sent, and the
 * scoped client only adds a workspace to a query while enforcement is on. With
 * it off — the default everywhere but production, and the rollback mode — the
 * owner of one workspace could open, save, rename and delete another's workflow
 * by its id.
 *
 * The two-tenant isolation harness records what it finds in the off mode and
 * fails only on the enforced one, so this boundary needs a test that FAILS in
 * the off mode. This is it: two real workspaces, a real database, the real
 * actions driven through a real session cookie (scripts/harness/actAs.ts), and
 * every verdict read back from the row — never from what an action said.
 *
 * Run in both modes, off first.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * what it creates.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { blankWorkflow } from "../src/lib/signflow/model";
import { ownedSignWorkflow } from "../src/lib/signflow/owned";
import { createSignWorkflow, deleteSignWorkflow, renameSignWorkflow, saveSignWorkflow } from "../src/app/actions/signflow";
import { seedTwoTenants, teardown } from "./harness/seed";
import { actAsStaff } from "./harness/actAs";

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

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

/**
 * What an action did, as a value. A refusal arrives three ways here — a result
 * that says no, a thrown redirect from the owner guard, a thrown error — and
 * none of them is the verdict: the row is.
 */
const settled = <T>(work: Promise<T>) => work.then((value) => ({ value, threw: null }), (error: unknown) => ({ value: null, threw: error }));

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`wf${SFX}`);
  const { a, b } = fixture;
  const made: string[] = [];
  const graph = JSON.stringify(blankWorkflow());
  const make = async (tenantId: string | null, name: string) => {
    const row = await basePrisma.signWorkflow.create({ data: { tenantId, name, graphJson: blankWorkflow() as object }, select: { id: true } });
    made.push(row.id);
    return row.id;
  };
  /** The row as it is, read past every guard. */
  const stored = (id: string) =>
    basePrisma.signWorkflow.findUniqueOrThrow({ where: { id }, select: { name: true, tenantId: true, deletedAt: true, updatedAt: true } });
  const untouched = async (id: string, before: Awaited<ReturnType<typeof stored>>) => {
    const after = await stored(id);
    return after.name === before.name && after.deletedAt === null && after.updatedAt.getTime() === before.updatedAt.getTime();
  };

  try {
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nSigning workflows, two workspaces — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const ownerOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { asOwner: true, enforcing });
      const ownerOfB = <T>(work: () => Promise<T>) => actAsStaff(b, work, { asOwner: true, enforcing });
      const staffOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });

      const mine = await make(a.tenantId, `A's own ${SFX}`);
      const theirs = await make(b.tenantId, `B's own ${SFX}`);
      const nobodys = await make(null, `No workspace ${SFX}`);
      const theirsBefore = await stored(theirs);
      const nobodysBefore = await stored(nobodys);

      // ── opening one ───────────────────────────────────────────────────────
      check("the owner of A opens A's workflow", (await ownerOfA(() => ownedSignWorkflow(mine)))?.id === mine);
      check("…and gets nothing for B's, by its id", (await ownerOfA(() => ownedSignWorkflow(theirs))) === null);
      check("…and nothing for one with no workspace: it is nobody's", (await ownerOfA(() => ownedSignWorkflow(nobodys))) === null);

      // ── saving ────────────────────────────────────────────────────────────
      const hijack = await settled(ownerOfA(() => saveSignWorkflow(theirs, "Hijacked by save", graph)));
      check("saving B's workflow from A is refused", hijack.value?.ok === false, JSON.stringify(hijack.value));
      check("…and B's workflow is exactly as it was", await untouched(theirs, theirsBefore), JSON.stringify(await stored(theirs)));
      await settled(ownerOfA(() => saveSignWorkflow(nobodys, "Claimed by save", graph)));
      check("a workflow with no workspace cannot be saved either", await untouched(nobodys, nobodysBefore));
      const ownSave = await settled(ownerOfA(() => saveSignWorkflow(mine, `A saved ${SFX}`, graph)));
      check("A's own workflow saves", ownSave.value?.ok === true && (await stored(mine)).name === `A saved ${SFX}`, JSON.stringify(ownSave));

      // ── renaming ──────────────────────────────────────────────────────────
      const rename = await settled(ownerOfA(() => renameSignWorkflow(theirs, "Hijacked by rename")));
      check("renaming B's workflow from A is refused", rename.value?.ok === false, JSON.stringify(rename.value));
      check("…and B's workflow is exactly as it was", await untouched(theirs, theirsBefore), JSON.stringify(await stored(theirs)));
      const ownRename = await settled(ownerOfA(() => renameSignWorkflow(mine, `A renamed ${SFX}`)));
      check("A's own workflow renames", ownRename.value?.ok === true && (await stored(mine)).name === `A renamed ${SFX}`, JSON.stringify(ownRename));

      // ── deleting ──────────────────────────────────────────────────────────
      const remove = await settled(ownerOfA(() => deleteSignWorkflow(theirs, form({ reason: "not mine to delete" }))));
      check("deleting B's workflow from A is refused", Boolean(remove.value && "error" in remove.value && remove.value.error), JSON.stringify(remove.value));
      check("…and B's workflow is still there", await untouched(theirs, theirsBefore), JSON.stringify(await stored(theirs)));
      await settled(ownerOfA(() => deleteSignWorkflow(nobodys, form({ reason: "not mine to delete" }))));
      check("a workflow with no workspace cannot be deleted either", await untouched(nobodys, nobodysBefore));

      // ── creating ──────────────────────────────────────────────────────────
      const name = `Created by A ${SFX} ${enforcing ? "on" : "off"}`;
      await settled(ownerOfA(() => createSignWorkflow(form({ name }))));
      const created = await basePrisma.signWorkflow.findFirst({ where: { name }, select: { id: true, tenantId: true } });
      if (created) made.push(created.id);
      check("a workflow A creates is stamped with A's workspace", created?.tenantId === a.tenantId, created ? `tenantId = ${created.tenantId}` : "no row was created");
      check("…so A can open the workflow it just made", Boolean(created) && (await ownerOfA(() => ownedSignWorkflow(created!.id)))?.id === created!.id);

      // ── the boundary is the workspace, not "nothing works" ────────────────
      const theirOwn = await settled(ownerOfB(() => saveSignWorkflow(theirs, `B saved ${SFX}`, graph)));
      check("B's owner still saves B's workflow", theirOwn.value?.ok === true && (await stored(theirs)).name === `B saved ${SFX}`, JSON.stringify(theirOwn));

      // ── design is the owner's (the reason this file's actions changed guard) ──
      const mineBefore = await stored(mine);
      await settled(staffOfA(() => saveSignWorkflow(mine, "Saved by staff", graph)));
      await settled(staffOfA(() => renameSignWorkflow(mine, "Renamed by staff")));
      await settled(staffOfA(() => deleteSignWorkflow(mine, form({ reason: "staff tried" }))));
      check("a member of A who holds every permission but is not its owner changes nothing", await untouched(mine, mineBefore), JSON.stringify(await stored(mine)));

      // ── and A deletes its own ─────────────────────────────────────────────
      const ownDelete = await settled(ownerOfA(() => deleteSignWorkflow(mine, form({ reason: "finished with it" }))));
      check("A's own workflow deletes", Boolean(ownDelete.value && "redirectTo" in ownDelete.value) && (await stored(mine)).deletedAt !== null, JSON.stringify(ownDelete));
      check("…and a deleted workflow no longer opens or saves", (await ownerOfA(() => ownedSignWorkflow(mine))) === null
        && (await settled(ownerOfA(() => saveSignWorkflow(mine, "Saved after delete", graph)))).value?.ok === false);
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.signWorkflow.deleteMany({ where: { OR: [{ id: { in: made } }, { tenantId: { in: [a.tenantId, b.tenantId] } }] } });
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
