/**
 * DAX multi-turn task evals, LIVE (roadmap §4, Phase 1 — job sheets).
 *
 *   NODE_ENV=test DAX_EVAL_TENANT_ID=<workspace> npm run eval:dax-tasks
 *
 * Runs each TASK_SCENARIOS conversation (evals/daxResearchQuality.ts) through the real askCrm — the real model —
 * presses Confirm on the quote cards the way the person would (runAssistantAction), then scores what the DATABASE
 * holds: the quote, its customer, lines and fees, nothing made twice. A fluent answer with no quote scores zero.
 *
 * NEEDS A LIVE MODEL: the workspace named by DAX_EVAL_TENANT_ID must have an AI service connected (Settings →
 * Integrations). Without one it says so and exits 2 — it never fakes a score. It is therefore NOT in CI; the
 * scorer itself is unit-tested (tests/daxResearchQuality.test.ts).
 *
 * SAFETY: local databases only (127.0.0.1 / localhost) and NODE_ENV=test — never the hosted dev database, which
 * holds live mail and WhatsApp credentials. It makes its own person (a workspace owner, so it sees the seeded
 * customers), its own two similarly named customers and, if missing, the two products; every quote it confirms is a DRAFT on those
 * customers and is never sent (DAX cannot send). All of it is removed afterwards.
 */
import crypto from "node:crypto";
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { signFreshSession } from "../src/lib/session";
import { runAsSession } from "./harness/actingSession";
import { TASK_SCENARIOS, formatReport, meanScore, scoreTaskScenario, type TaskOutcome } from "../evals/daxResearchQuality";

const SFX = Math.random().toString(16).slice(2, 10);
const QUOTE_KINDS = new Set(["quote_build", "quote_add", "quote_change"]);

function guardEnvironment(): string {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://none");
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`Refusing to run against ${url.hostname} — local databases only`);
  const tenantId = process.env.DAX_EVAL_TENANT_ID ?? "";
  if (!tenantId) throw new Error("Set DAX_EVAL_TENANT_ID to a local workspace that has an AI service connected");
  return tenantId;
}

async function main(): Promise<number> {
  const tenantId = guardEnvironment();
  const { askCrm } = await import("../src/lib/crmAssistant");
  const { isCodexConnected } = await import("../src/lib/codex");
  const { runAssistantAction } = await import("../src/app/actions/assistant");
  const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId, system: false }, fn);

  if (!(await scoped(() => isCodexConnected()))) {
    console.log(`SKIPPED — workspace ${tenantId} has no AI service connected, so there is no model to evaluate. Connect one (Settings → Integrations) in the local sandbox and run again.`);
    return 2;
  }
  const clash = await basePrisma.contact.count({ where: { tenantId, deletedAt: null, firstName: "Anna", lastName: { in: ["Jacobs", "Jacobsen"] } } });
  if (clash) throw new Error("This workspace already has an Anna Jacobs / Jacobsen — the similar-names scenario needs exactly the seeded pair");

  // The eval's own person: a workspace owner (sees every customer, may quote), with a session the actions accept.
  const user = { id: crypto.randomUUID(), name: `DAX Eval ${SFX}`, email: `dax-eval-${SFX}@example.invalid`, role: "owner" };
  await basePrisma.user.create({ data: { ...user, passwordHash: "not-a-real-hash", modules: "crm" } });
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${crypto.randomUUID()}, ${tenantId}, ${user.id})`;
  const session = { cookieValue: await signFreshSession({ ...user, grants: "", sessionVersion: 0 }, 60, { tid: tenantId }), label: "dax eval" };
  const asThem = <R>(fn: () => Promise<R>) => runAsSession(session, () => scoped(fn));

  const contacts = [
    await basePrisma.contact.create({ data: { tenantId, firstName: "Anna", lastName: "Jacobs", ownerId: user.id, createdById: user.id }, select: { id: true } }),
    await basePrisma.contact.create({ data: { tenantId, firstName: "Anna", lastName: "Jacobsen", ownerId: user.id, createdById: user.id }, select: { id: true } }),
  ];
  const madeProducts: string[] = [];
  for (const [name, price, colours] of [["Denago Rover XL", 23_500_000, ["White", "Gray"]], ["Golf Caddie", 450_000, []]] as const) {
    const exists = await basePrisma.product.findFirst({ where: { tenantId, name, active: true, deletedAt: null }, select: { id: true } });
    if (exists) continue;
    const made = await basePrisma.product.create({
      data: { tenantId, name, basePriceCents: price, colors: { create: colours.map((colour) => ({ tenantId, name: colour })) } },
      select: { id: true },
    });
    madeProducts.push(made.id);
  }

  const scores = [];
  try {
    for (const scenario of TASK_SCENARIOS) {
      const started = new Date();
      const answers: string[] = [];
      const latencyMs: number[] = [];
      for (const turn of scenario.turns) {
        if (turn.afterHours) {
          // Time passes: the conversation so far, and its job sheets, are moved back — past the 3-hour window.
          const shift = turn.afterHours * 3_600_000;
          await basePrisma.$executeRaw`UPDATE "AssistantTurn" SET "createdAt" = "createdAt" - (${shift} * interval '1 millisecond') WHERE "userId" = ${user.id}`;
          await basePrisma.$executeRaw`UPDATE "AssistantTask" SET "updatedAt" = "updatedAt" - (${shift} * interval '1 millisecond') WHERE "userId" = ${user.id}`;
        }
        const t0 = Date.now();
        const result = await asThem(() =>
          askCrm(user, turn.ask, null, turn.channel === "whatsapp" ? { source: "whatsapp", proposeTasks: "saved" } : {}),
        );
        latencyMs.push(Date.now() - t0);
        answers.push(result.ok ? result.answer : `(failed: ${result.error})`);
        if (turn.confirm && result.ok) {
          for (const card of result.actions.filter((c) => QUOTE_KINDS.has(c.kind))) await asThem(() => runAssistantAction(card));
        }
      }
      const quotes = await basePrisma.quote.findMany({
        where: { tenantId, createdById: user.id, createdAt: { gte: started }, deletedAt: null },
        select: { contact: { select: { firstName: true, lastName: true } }, items: { select: { description: true, qty: true, colorPreference: true } }, fees: { select: { label: true, amountCents: true } } },
      });
      const outcome: TaskOutcome = {
        quotes: quotes.map((q) => ({
          customer: [q.contact?.firstName, q.contact?.lastName].filter(Boolean).join(" "),
          lines: q.items.map((i) => ({ product: i.description, qty: i.qty, ...(i.colorPreference ? { colour: i.colorPreference } : {}) })),
          fees: q.fees.map((f) => ({ label: f.label, amount: f.amountCents / 100 })),
        })),
        openSheets: await basePrisma.assistantTask.count({ where: { userId: user.id, status: "open" } }),
        answers,
        latencyMs,
      };
      scores.push(scoreTaskScenario(scenario, outcome));
      // Each scenario starts from nothing: no sheets, no conversation, no quotes of this person's.
      await cleanQuotes(user.id);
      await basePrisma.assistantTask.deleteMany({ where: { userId: user.id } });
      await basePrisma.assistantTurn.deleteMany({ where: { userId: user.id } });
    }
  } finally {
    await cleanQuotes(user.id).catch(() => {});
    await basePrisma.assistantTask.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await basePrisma.assistantTurn.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await basePrisma.assistantRun.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await basePrisma.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } }).catch(() => {});
    await basePrisma.productColor.deleteMany({ where: { productId: { in: madeProducts } } }).catch(() => {});
    await basePrisma.product.deleteMany({ where: { id: { in: madeProducts } } }).catch(() => {});
    await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" = ${user.id}`.catch(() => {});
    // The audit trail is append-only and may still name this person: then the user row stays (local database only).
    await basePrisma.user.delete({ where: { id: user.id } }).catch(() => console.log(`(left the eval user ${user.id} — the audit trail refers to it)`));
  }
  console.log(formatReport(scores));
  return meanScore(scores) >= 75 ? 0 : 1;
}

async function cleanQuotes(userId: string) {
  const ids = (await basePrisma.quote.findMany({ where: { createdById: userId }, select: { id: true } })).map((q) => q.id);
  if (!ids.length) return;
  await basePrisma.quoteItem.deleteMany({ where: { quoteId: { in: ids } } });
  await basePrisma.quoteFee.deleteMany({ where: { quoteId: { in: ids } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: ids } } });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => { console.error("\nEVAL FAILED TO RUN", error); process.exit(1); });
