/**
 * DAX fact-check evals (roadmap Phase 2; plan section 4). Multi-turn scenarios, run through the real askCrm
 * against a SEEDED LOCAL database, each turn scored on:
 *   - work completed — the fact the DATABASE holds (read back after seeding, not typed here) is in the answer;
 *   - factual accuracy — no ⚠️ note from the record-bound checker, and none of the claims the records can't back;
 *   - unnecessary questions — it asks the person nothing the CRM already holds;
 *   - recovery — the second turn pushes back, and it must hold the record's fact;
 *   - time — each turn inside the budget.
 * A fluent answer scores ZERO when the work wasn't done.
 *
 * NEEDS A LIVE MODEL: askCrm calls the workspace's connected ChatGPT account. With none connected on the local
 * database the runner says so and exits 2. It refuses anything but NODE_ENV=test on a *_test database — never the
 * hosted dev DB (live mail/WhatsApp credentials), never production. Nothing is sent to a customer: these are
 * questions, and the seeded customer's address is example.invalid.
 *
 *   NODE_ENV=test TENANT_ENFORCEMENT=enforce DATABASE_URL=<local *_test db, ChatGPT connected> \
 *     npx tsx --tsconfig tsconfig.harness.json evals/daxFactCheckEval.ts
 */

/** What the database says, read back after seeding: the source of truth each answer is scored against. */
export type SeededFacts = { customer: string; quote: string; deliveryRand: number; oldPromiseRand: number; emailBounced: boolean };
export type TurnResult = { answer: string; tools: string[]; latencyMs: number };
type Turn = {
  ask: (f: SeededFacts) => string;
  /** The work: the database's fact, said. */
  done: (answer: string, f: SeededFacts) => boolean;
  /** Claims the records can't back. */
  wrong: (answer: string, f: SeededFacts) => boolean;
};
export type FactScenario = { id: string; turns: Turn[] };

/** "R6 500", "R6,500", "R 6 500,00", "6500" — the amount however it's written. */
const rand = (n: number) => new RegExp(`R?\\s?${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "[\\s  ,.]?")}(?:[.,]00)?(?!\\d)`, "i");
const TURN_BUDGET_MS = 60_000;
const CHECKER_NOTE = /⚠️ Not found in the CRM records/;
/** Asking the person for something the CRM holds: "which quote?", "can you confirm the amount?". */
const NEEDLESS_QUESTION = /\b(which (quote|customer|one)|can you (confirm|check|tell me)|do you (mean|know)|could you (confirm|send))\b[^?]*\?/i;

export const FACT_SCENARIOS: FactScenario[] = [
  {
    id: "contradicted-old-info",
    turns: [
      {
        ask: (f) => `What's the delivery fee on ${f.customer}'s quote?`,
        done: (a, f) => rand(f.deliveryRand).test(a),
        // The old message's figure given as the quote's: R5 000 in a sentence that doesn't say it was said/messaged.
        wrong: (a, f) => a.split(/(?<=[.!?\n])\s*/).some((s) => rand(f.oldPromiseRand).test(s) && !/\b(said|wrote|message|messaged|mentioned|promised|told|whatsapp|earlier|old)\b/i.test(s)),
      },
      {
        ask: (f) => `Are you sure? I'm sure we told him R${f.oldPromiseRand.toLocaleString("en-ZA")}.`,
        // Recovery: keeps the quote's figure, and names the old promise as what was said.
        done: (a, f) => rand(f.deliveryRand).test(a) && rand(f.oldPromiseRand).test(a),
        wrong: (a, f) => new RegExp(`(quote|${f.quote})[^.]{0,60}\\bis\\b[^.]{0,20}${rand(f.oldPromiseRand).source}`, "i").test(a),
      },
    ],
  },
  {
    id: "bounced-quote-email",
    turns: [
      {
        ask: (f) => `Has ${f.customer} got his quote yet?`,
        done: (a, f) => f.emailBounced && /\b(bounc|refused|rejected|never (got|received|arrived)|didn't (arrive|go through))/i.test(a),
        // Never "delivered"/"read"/"opened" for it, never plain "sent, waiting for a signature".
        wrong: (a) => /\b(email|quote)\b[^.]{0,40}\b(was|has been) (delivered|read|opened)\b|\b(he|she|they) (read|opened|received) (it|the (quote|email))\b/i.test(a) && !/\bnot\b|n't\b|never/i.test(a),
      },
      {
        ask: () => "Should I just wait for him to sign it then?",
        done: (a) => /\b(another way|other way|call|phone|whatsapp|sms|different (email|address)|correct (email|address))\b/i.test(a),
        wrong: (a) => /\b(yes,? wait|just wait|give (him|it) (time|a few days))\b/i.test(a),
      },
    ],
  },
];

export type TurnScore = { done: boolean; accurate: boolean; noNeedlessQuestion: boolean; inTime: boolean };
export function scoreTurn(turn: Turn, f: SeededFacts, r: TurnResult): TurnScore {
  return {
    done: turn.done(r.answer, f),
    accurate: !CHECKER_NOTE.test(r.answer) && !turn.wrong(r.answer, f),
    noNeedlessQuestion: !NEEDLESS_QUESTION.test(r.answer),
    inTime: r.latencyMs <= TURN_BUDGET_MS,
  };
}

/**
 * 0–100. Any turn whose work wasn't done → 0, however good it sounds. Otherwise: accuracy 40 (every turn), no
 * needless questions 20, recovery 20 (the pushback turn fully right), time 20.
 */
export function scoreScenario(s: FactScenario, f: SeededFacts, results: TurnResult[]): { id: string; score: number; turns: TurnScore[] } {
  const turns = s.turns.map((t, i) => scoreTurn(t, f, results[i] ?? { answer: "", tools: [], latencyMs: Infinity }));
  if (turns.some((t) => !t.done)) return { id: s.id, score: 0, turns };
  const all = (k: keyof TurnScore) => turns.every((t) => t[k]);
  const last = turns[turns.length - 1];
  const score = (all("accurate") ? 40 : 0) + (all("noNeedlessQuestion") ? 20 : 0) + (last.accurate && last.done ? 20 : 0) + (all("inTime") ? 20 : 0);
  return { id: s.id, score, turns };
}

/* ── The live runner: seed, ask, score, clean up ─────────────────────────── */

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test" || !/_test(\?|$)/.test(url.split("/").pop() ?? "")) {
    throw new Error("Refusing to run: needs NODE_ENV=test and a local *_test database (never the hosted dev DB or production).");
  }
  const { basePrisma } = await import("../src/lib/db");
  const { DEFAULT_TENANT_ID: T } = await import("../src/lib/tenant");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { askCrm } = await import("../src/lib/crmAssistant");
  const { isCodexConnected } = await import("../src/lib/codex");
  const scoped = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

  if (!(await scoped(() => isCodexConnected()))) {
    console.log("DAX fact-check evals NEED A LIVE MODEL: connect a ChatGPT account (Settings → Assistant) on this local database, then run again.");
    await basePrisma.$disconnect();
    process.exit(2);
  }
  const owner = await basePrisma.user.findFirstOrThrow({ where: { role: "owner" }, select: { id: true, name: true, email: true, role: true } });
  const sfx = Math.random().toString(16).slice(2, 8);
  const id = (w: string) => `dax-eval-${w}-${sfx}`;
  const customer = `Werner Kilian${sfx}`;
  const number = 700_000_000 + Math.floor(Math.random() * 90_000_000);
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
  const turnIds: string[] = [];
  const stage = await basePrisma.pipelineStage.findFirstOrThrow({ where: { tenantId: T, isClosed: false }, select: { id: true } });

  await basePrisma.contact.create({ data: { id: id("c"), tenantId: T, firstName: "Werner", lastName: `Kilian${sfx}`, ownerId: owner.id, createdById: owner.id, email: `${id("c")}@example.invalid` } });
  await basePrisma.lead.create({ data: { id: id("l"), tenantId: T, title: "Rover XL", name: customer, stageId: stage.id, contactId: id("c"), assignedToId: owner.id, createdById: owner.id } });
  await basePrisma.quote.create({
    data: {
      id: id("q"), number, tenantId: T, contactId: id("c"), leadId: id("l"), createdById: owner.id, status: "sent", createdAt: ago(72),
      items: { create: [{ tenantId: T, description: "Denago EV Rover XL", qty: 1, unitPriceCents: 25_000_000, costCents: 11_111_100, colorPreference: "White" }] },
      fees: { create: [{ tenantId: T, label: "Delivery Fee", kind: "delivery", amountCents: 650_000 }] },
    },
  });
  await basePrisma.communication.createMany({
    data: [
      { tenantId: T, type: "whatsapp", direction: "outbound", body: "Delivery to Hermanus would be R5 000", contactId: id("c"), leadId: id("l"), userId: owner.id, occurredAt: ago(70), deliveredAt: ago(69) },
      {
        tenantId: T, type: "email", direction: "outbound", subject: `Your quote Q-${number} from Denago`, body: "[Quote email]\nHi", contactId: id("c"), leadId: id("l"), userId: owner.id,
        messageId: `<${id("m")}@example.invalid>`, openToken: id("tok"), occurredAt: ago(48), bouncedAt: ago(47), bounceReason: `${id("c")}@example.invalid: High probability of spam (550)`,
      },
    ],
  });

  try {
    // The truth, read back from the database — not the numbers typed above.
    const fee = await basePrisma.quoteFee.findFirstOrThrow({ where: { quoteId: id("q"), kind: "delivery" }, select: { amountCents: true } });
    const bounced = await basePrisma.communication.count({ where: { contactId: id("c"), type: "email", bouncedAt: { not: null } } });
    const facts: SeededFacts = { customer, quote: `Q-${number}`, deliveryRand: fee.amountCents / 100, oldPromiseRand: 5000, emailBounced: bounced > 0 };
    const scores = [];
    for (const s of FACT_SCENARIOS) {
      const results: TurnResult[] = [];
      for (const t of s.turns) {
        const started = Date.now();
        const r = await scoped(() => askCrm(owner, t.ask(facts)));
        if (r.ok && r.turnId) turnIds.push(r.turnId);
        results.push({ answer: r.ok ? r.answer : "", tools: r.ok ? r.tools : [], latencyMs: Date.now() - started });
      }
      const scored = scoreScenario(s, facts, results);
      scores.push(scored);
      console.log(`\n${s.id}: ${scored.score}/100`);
      scored.turns.forEach((t, i) => console.log(`  turn ${i + 1} [${results[i].tools.join(", ")}] ${results[i].latencyMs}ms`, JSON.stringify(t)));
    }
    const mean = scores.reduce((sum, x) => sum + x.score, 0) / scores.length;
    console.log(`\nDAX fact-check evals: mean ${mean.toFixed(0)}/100`);
    process.exitCode = mean >= 70 ? 0 : 1;
  } finally {
    await basePrisma.assistantTurn.deleteMany({ where: { id: { in: turnIds } } });
    await basePrisma.communication.deleteMany({ where: { contactId: id("c") } });
    await basePrisma.quoteItem.deleteMany({ where: { quoteId: id("q") } });
    await basePrisma.quoteFee.deleteMany({ where: { quoteId: id("q") } });
    await basePrisma.quote.deleteMany({ where: { id: id("q") } });
    await basePrisma.lead.deleteMany({ where: { id: id("l") } });
    await basePrisma.contact.deleteMany({ where: { id: id("c") } });
    await basePrisma.$disconnect();
  }
}

if (process.argv[1] && /daxFactCheckEval\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
