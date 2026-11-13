/**
 * REAL-DATABASE proof that a DAX report PDF is made only from an answer in the workspace being acted in (review of
 * #1093: src/app/api/pdf/assistant-report/[turnId]/route.tsx → lib/assistantReportTurn.ts).
 *
 * The same person belongs to two workspaces and has an answer in each. With tenant ENFORCEMENT OFF — the case the
 * review named, where nothing filters the query for us — acting in workspace B:
 *  - B's own answer is found;
 *  - A's answer, asked for by its id, is NOT (it would have been printed under B's name and logo);
 *  - someone else's answer in B is not either.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, removes every row it creates. No PDF is drawn.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { findReportTurn } from "../src/lib/assistantReportTurn";

const SFX = Math.random().toString(36).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const A = DEFAULT_TENANT_ID;
const B = `t_report_${SFX}`;
const person = { id: `rp-me-${SFX}`, name: "Report me", email: `rp-me-${SFX}@example.invalid` };
const other = { id: `rp-other-${SFX}`, name: "Report other", email: `rp-other-${SFX}@example.invalid` };
const TURN = { inA: `c${SFX}turnina00000000`, inB: `c${SFX}turninb00000000`, othersInB: `c${SFX}turnother000000` };
const inB = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: B, system: false }, fn);

async function seed() {
  await basePrisma.tenant.create({ data: { id: B, name: `Report ${SFX}`, slug: B, active: true } });
  await basePrisma.user.createMany({ data: [person, other].map((u) => ({ ...u, passwordHash: "test", role: "member", modules: "crm" })) });
  const ask = "Give me a PDF report of my stuck deals";
  await basePrisma.assistantTurn.createMany({
    data: [
      { id: TURN.inA, tenantId: A, userId: person.id, question: ask, answer: "Workspace A's pipeline: R1 200 000.", source: "chat" },
      { id: TURN.inB, tenantId: B, userId: person.id, question: ask, answer: "Workspace B's pipeline.", source: "chat" },
      { id: TURN.othersInB, tenantId: B, userId: other.id, question: ask, answer: "Someone else's.", source: "chat" },
    ],
  });
}

async function cleanup() {
  await basePrisma.assistantTurn.deleteMany({ where: { id: { in: Object.values(TURN) } } });
  await basePrisma.user.deleteMany({ where: { id: { in: [person.id, other.id] } } });
  await basePrisma.tenant.deleteMany({ where: { id: B } });
}

async function main() {
  guardEnvironment();
  await seed();
  // Enforcement OFF: the workspace boundary has to come from the query itself.
  __setTenantEnforcingForTests(false);
  const mine = await inB(() => findReportTurn(B, person.id, TURN.inB));
  check("acting in B: my answer in B is found", mine?.answer === "Workspace B's pipeline.", JSON.stringify(mine));
  const fromA = await inB(() => findReportTurn(B, person.id, TURN.inA));
  check("acting in B: my answer from A, by its id, is NOT found (no 'A' figures under B's logo)", fromA === null, JSON.stringify(fromA));
  const theirs = await inB(() => findReportTurn(B, person.id, TURN.othersInB));
  check("acting in B: someone else's answer is not found", theirs === null);
  // And A's own answer is still A's, where it belongs.
  const inA = await runInTenantScope({ tenantId: A, system: false }, () => findReportTurn(A, person.id, TURN.inA));
  check("acting in A: my answer in A is found", inA?.answer === "Workspace A's pipeline: R1 200 000.");
  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    __setTenantEnforcingForTests(false);
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
