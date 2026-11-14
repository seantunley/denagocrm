/**
 * REAL-DATABASE proof that DAX revises the EXACT draft the person saw (DAX_Conversational_Upgrades.md §1).
 *
 *   npm run test:assistant-drafts     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * The acceptance scenario, through the column and the loader DAX uses (no AI is called):
 *  - an email longer than 400 characters, with the delivery promise in its closing paragraph and Ivan in copy, is kept
 *    on its turn; FOUR turns later "change only the greeting" gets that email in FULL — every paragraph, the deal it
 *    is for, the subject and the Cc;
 *  - after "turn that into a WhatsApp", the WhatsApp is listed AND the email is still there with its Cc, and asking
 *    about "the email" brings it back in full;
 *  - never a colleague's drafts, another conversation's, or another workspace's — even in the same seconds.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { conversationDrafts } from "../src/lib/assistantDrafts";
import { draftsBlock, draftsToKeep } from "../src/lib/assistantDraftRules";

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

const cid = () => `c${SFX}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 25).padEnd(25, "0");
const T = DEFAULT_TENANT_ID;
const T2 = `t_draft_${SFX}`;
const me = { id: `dr-me-${SFX}`, name: "Dr me", email: `dr-me-${SFX}@example.invalid` };
const colleague = { id: `dr-col-${SFX}`, name: "Dr colleague", email: `dr-col-${SFX}@example.invalid` };
const CONV = `conv-draft-${SFX}`;
const OTHER_CONV = `conv-other-${SFX}`;
const LEAD = `lead_angelique_${SFX}`;
const turnIds: string[] = [];
const inT = <R>(tenantId: string, fn: () => Promise<R>) => runInTenantScope({ tenantId, system: false }, fn);

const CLOSING = "We will deliver the Rover XL to your Cape Town address on Friday 21 November, before noon.";
const BODY = `Dear Angelique,\n\n${"Thank you for your time today. Attached is the quotation for the Rover XL in Sable Grey, with the charging kit and the two-year service plan we discussed. ".repeat(3)}\n\n${CLOSING}\n\nKind regards,\nSean`;
const emailCard = { kind: "draft_message", leadId: LEAD, leadLabel: "Angelique Botha", channel: "email", subject: "Your Rover XL quotation", body: BODY, cc: ["ivan@denago.test"] };
const whatsappCard = { kind: "draft_message", leadId: LEAD, leadLabel: "Angelique Botha", channel: "whatsapp", body: "Hi Angelique, your Rover XL quote is in your inbox — delivery Friday 21 Nov before noon, to Cape Town." };

async function turn(data: { tenantId?: string; userId?: string; conversationId?: string; secondsAgo: number; drafts?: object[] }) {
  const id = cid();
  turnIds.push(id);
  await basePrisma.assistantTurn.create({
    data: {
      id, tenantId: data.tenantId ?? T, userId: data.userId ?? me.id, question: "q", answer: "a", source: "chat",
      conversationId: data.conversationId ?? CONV, createdAt: new Date(Date.now() - data.secondsAgo * 1000),
      ...(data.drafts ? { drafts: draftsToKeep(data.drafts as never) as object } : {}),
    },
  });
}

async function main() {
  guardEnvironment();
  await basePrisma.tenant.create({ data: { id: T2, name: `Drafts ${SFX}`, slug: T2, active: true } });
  await basePrisma.user.createMany({ data: [me, colleague].map((u) => ({ ...u, passwordHash: "test", role: "member", modules: "crm" })) });

  // Turn 1: the email. Turns 2–5: four more exchanges with no draft — past the three DAX reads word for word.
  await turn({ secondsAgo: 60, drafts: [emailCard] });
  for (const s of [50, 40, 30, 20]) await turn({ secondsAgo: s });
  // In the same seconds: a colleague's draft in the SAME conversation id, mine in another conversation, and another
  // workspace's — none of which may reach this conversation.
  await turn({ secondsAgo: 15, userId: colleague.id, drafts: [{ ...emailCard, body: "COLLEAGUE'S DRAFT", cc: ["leak@x.test"] }] });
  await turn({ secondsAgo: 15, conversationId: OTHER_CONV, drafts: [{ ...emailCard, body: "OTHER CONVERSATION'S DRAFT" }] });
  await turn({ secondsAgo: 15, tenantId: T2, drafts: [{ ...emailCard, body: "OTHER WORKSPACE'S DRAFT" }] });

  __setTenantEnforcingForTests(true);
  const who = { tenantId: T, userId: me.id };

  console.log("\nFour turns later: \"change only the greeting\"");
  const drafts = await inT(T, () => conversationDrafts(who, CONV));
  check("the conversation has exactly one draft — mine, here", drafts.length === 1, JSON.stringify(drafts.map((d) => d.body.slice(0, 30))));
  const block = draftsBlock(drafts, "change only the greeting");
  check("the email in FULL — longer than 400 characters, word for word", BODY.length > 400 && block.includes(BODY));
  check("…its closing paragraph's delivery promise", block.includes(CLOSING));
  check("…the deal it is for, its subject and its Cc", block.includes(`leadId ${LEAD}`) && block.includes("Subject: Your Rover XL quotation") && block.includes("Cc: ivan@denago.test"));
  check("nothing of a colleague's, another conversation's or another workspace's", !/COLLEAGUE|OTHER CONVERSATION|OTHER WORKSPACE|leak@x\.test/.test(block));

  console.log("\n\"Turn that into a WhatsApp\" — and the email stays");
  await turn({ secondsAgo: 5, drafts: [whatsappCard] });
  const both = await inT(T, () => conversationDrafts(who, CONV));
  check("both drafts, oldest first", both.length === 2 && both[0].channel === "email" && both[1].channel === "whatsapp");
  check("the WhatsApp is to the same deal, and has no Cc", both[1].leadId === LEAD && !both[1].cc);
  const listed = draftsBlock(both, "make the WhatsApp warmer");
  check("the email is still listed with Ivan in copy", /Draft 1 — Email to Angelique Botha .*cc ivan@denago\.test/.test(listed));
  const back = draftsBlock(both, "now add the Golf Caddie to the email");
  check("asked about the email: it is back in full, Cc and all", back.includes(BODY) && back.includes("Cc: ivan@denago.test"));

  console.log("\nAnother workspace, asking for this conversation");
  const elsewhere = await inT(T2, () => conversationDrafts({ tenantId: T2, userId: me.id }, CONV));
  check("finds only its own — never this workspace's email", elsewhere.every((d) => d.body === "OTHER WORKSPACE'S DRAFT"), JSON.stringify(elsewhere.map((d) => d.body.slice(0, 30))));

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    __setTenantEnforcingForTests(false);
    await basePrisma.assistantTurn.deleteMany({ where: { id: { in: turnIds } } }).catch((e) => console.error("cleanup failed", e));
    await basePrisma.user.deleteMany({ where: { id: { in: [me.id, colleague.id] } } }).catch(() => 0);
    await basePrisma.tenant.deleteMany({ where: { id: T2 } }).catch(() => 0);
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
