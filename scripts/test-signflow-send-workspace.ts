/**
 * A QUOTE GOES THROUGH A WORKFLOW OF ITS OWN WORKSPACE, AND A WORKSPACE'S
 * DEFAULT IS ONE OF ITS OWN — WITH TENANT ENFORCEMENT OFF.
 *
 * Four places read a signing workflow without naming a workspace: the action
 * that makes one the default, the list it is chosen from, the picker on the
 * send card, and the send itself, which took the id the browser sent. The
 * scoped client adds the workspace only while enforcement is on. With it off —
 * the default everywhere but production, and the rollback mode — a workspace
 * was shown every other workspace's workflows, could save one as its own
 * default, and could send its quote through one: approvals raised for another
 * company's people.
 *
 * So this drives the real action, the real page, the real card data and the
 * real envelope resolution as signed-in people of two workspaces, in both
 * modes, off first. The two-tenant harness only records what it finds with
 * enforcement off, which is why this needs a test that fails there.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and puts
 * back the one shared setting it writes in the off mode.
 */
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { blankWorkflow } from "../src/lib/signflow/model";
import { SIGNING_DEFAULT_WORKFLOW_KEY, defaultSignWorkflowId } from "../src/lib/signflow/defaultWorkflow";
import { resolveEnvelope } from "../src/lib/signing/autoEnvelope";
import { setDefaultSignWorkflow } from "../src/app/actions/signflowDefault";
import { quoteSigningView } from "../src/app/actions/recordSigning";
import SigningWorkflowsPage from "../src/app/(app)/settings/signing-workflows/page";
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

/** What an action did, as a value: a result, or whatever it threw (the owner guard refuses with a redirect). */
const settled = <T>(work: Promise<T>) => work.then((value) => ({ value, threw: null }), (error: unknown) => ({ value: null, threw: error }));
const refusal = (outcome: { value: unknown }) => (outcome.value && typeof outcome.value === "object" && "error" in outcome.value ? String(outcome.value.error) : null);

/** Every string anywhere in an element tree: what a page would show, without rendering it. */
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
  const fixture = await seedTwoTenants(`ws${SFX}`);
  const { a, b } = fixture;
  const made: string[] = [];
  const make = async (tenantId: string | null, name: string, extra: { deletedAt?: Date; isArchived?: boolean } = {}) => {
    const row = await basePrisma.signWorkflow.create({ data: { tenantId, name, graphJson: blankWorkflow() as object, ...extra }, select: { id: true } });
    made.push(row.id);
    return row.id;
  };
  const names = { mine: `Workflow of A ${SFX}`, theirs: `Workflow of B ${SFX}`, nobodys: `Workflow of nobody ${SFX}` };
  const mine = await make(a.tenantId, names.mine);
  const theirs = await make(b.tenantId, names.theirs);
  const nobodys = await make(null, names.nobodys);
  const deleted = await make(a.tenantId, `Deleted workflow of A ${SFX}`, { deletedAt: new Date() });
  const archived = await make(a.tenantId, `Archived workflow of A ${SFX}`, { isArchived: true });

  // With enforcement off every workspace's settings are the founding workspace's
  // row, so this test writes a value other suites may be reading. Put it back.
  const settingBefore = await basePrisma.appSetting.findMany({ where: { key: SIGNING_DEFAULT_WORKFLOW_KEY }, select: { tenantId: true, value: true } });

  try {
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      console.log(`\nSigning workflows at the send, two workspaces — tenant enforcement ${enforcing ? "ON" : "off"}`);
      const ownerOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { asOwner: true, enforcing });
      const staffOfA = <T>(work: () => Promise<T>) => actAsStaff(a, work, { enforcing });
      const staffOfB = <T>(work: () => Promise<T>) => actAsStaff(b, work, { enforcing });
      const defaultOfA = () => ownerOfA(() => defaultSignWorkflowId());

      // ── the default ───────────────────────────────────────────────────────
      await ownerOfA(() => setDefaultSignWorkflow(""));
      const foreign = await settled(ownerOfA(() => setDefaultSignWorkflow(theirs)));
      const missing = await settled(ownerOfA(() => setDefaultSignWorkflow(`no_such_workflow_${SFX}`)));
      check("A cannot make B's workflow its default", Boolean(refusal(foreign)), JSON.stringify(foreign.value));
      check("…and is told exactly what it is told for an id that does not exist", refusal(foreign) !== null && refusal(foreign) === refusal(missing), `${refusal(foreign)} / ${refusal(missing)}`);
      check("…with nothing of B's in the answer", !JSON.stringify(foreign.value).includes(names.theirs));
      check("…and no default is saved", (await defaultOfA()) === null, String(await defaultOfA()));
      check("a workflow with no workspace cannot be made the default either", Boolean(refusal(await settled(ownerOfA(() => setDefaultSignWorkflow(nobodys))))) && (await defaultOfA()) === null);
      const staffTry = await settled(staffOfA(() => setDefaultSignWorkflow(mine)));
      check("a member of A who is not its owner cannot set the default", (await defaultOfA()) === null, JSON.stringify(staffTry.value));
      const own = await settled(ownerOfA(() => setDefaultSignWorkflow(mine)));
      check("A's owner makes A's own workflow the default", refusal(own) === null && (await defaultOfA()) === mine, JSON.stringify(own.value));

      // ── the list it is chosen from ────────────────────────────────────────
      const listed = textOf(await ownerOfA(() => SigningWorkflowsPage()));
      check("A's workflow list shows A's workflow", listed.some((piece) => piece.includes(names.mine)));
      check("…and neither B's nor the one with no workspace", !listed.some((piece) => piece.includes(names.theirs) || piece.includes(names.nobodys)));

      // ── the picker on the send card ───────────────────────────────────────
      const card = await staffOfA(() => quoteSigningView(a.rows.quoteId));
      const offered = card?.workflows.map((workflow) => workflow.id) ?? [];
      check("the send card on A's quote offers A's workflow", offered.includes(mine), JSON.stringify(offered));
      check("…and not B's, not the unowned one, and not A's deleted or archived ones", ![theirs, nobodys, deleted, archived].some((id) => offered.includes(id)), JSON.stringify(offered));
      check("…and starts on A's default", card?.defaultWorkflowId === mine, String(card?.defaultWorkflowId));
      const theirCard = await staffOfB(() => quoteSigningView(b.rows.quoteId));
      check("B's card offers B's workflow and not A's", Boolean(theirCard?.workflows.some((workflow) => workflow.id === theirs)) && !theirCard?.workflows.some((workflow) => workflow.id === mine), JSON.stringify(theirCard?.workflows.map((workflow) => workflow.id)));

      // ── the send itself: the id arrives from the browser ──────────────────
      const through = (workflowId: string) =>
        staffOfA(() => resolveEnvelope({ quoteId: a.rows.quoteId, workflowId, signer: { name: "Sender", email: `sender.${SFX}@harness.invalid` } }));
      const stopped = (result: Awaited<ReturnType<typeof through>>) => Boolean(result && "workflowGone" in result);
      check("A's quote is not sent through B's workflow", stopped(await through(theirs)), JSON.stringify(Object.keys((await through(theirs)) ?? {})));
      check("…nor through one with no workspace", stopped(await through(nobodys)));
      check("…nor through a deleted or archived one — it stops, rather than going out the built-in way", stopped(await through(deleted)) && stopped(await through(archived)));
      const ownSend = await through(mine);
      check("…and through A's own workflow it is prepared, or asks who fills an open step", Boolean(ownSend) && !stopped(ownSend), JSON.stringify(Object.keys(ownSend ?? {})));

      await ownerOfA(() => setDefaultSignWorkflow(""));
      check("clearing the default leaves none", (await defaultOfA()) === null);
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.appSetting.deleteMany({ where: { key: SIGNING_DEFAULT_WORKFLOW_KEY } });
    if (settingBefore.length) await basePrisma.appSetting.createMany({ data: settingBefore.map((row) => ({ ...row, key: SIGNING_DEFAULT_WORKFLOW_KEY })) });
    await basePrisma.signWorkflow.deleteMany({ where: { id: { in: made } } });
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
