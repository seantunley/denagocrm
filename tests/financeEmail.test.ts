import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { matchFinanceEmail } from "../src/lib/dealFinanceRules";
import { KEPT_BODY_CHARS, storedFinanceEmailBody, storedFinanceEmailSubject } from "../src/lib/financeEmailRules";

// fileFinanceHouseEmail against a world the test controls: one finance house, one deal (APP-77), its salesperson.
const world = { owner: null as string | null, mayOpen: true, dedupe: 0, financeOn: true };
const pushes: { payload: unknown; kind: unknown; options: unknown }[] = [];
const stored: Record<string, unknown>[] = [];
const fakeDb = {
  vendor: { findMany: async () => [{ id: "wesbank", name: "WesBank" }] },
  communication: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => { stored.push(data); return data; } },
  dealFinance: { findMany: async () => [{ id: "f1", tenantId: "tenant_a", leadId: "lead_1", reference: "APP-77", vendorId: "wesbank" }] },
  lead: { findMany: async () => [{ id: "lead_1", name: "Jody Van Heerden", contactId: "cust_1", assignedToId: world.owner }] },
  user: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: "Rep", email: "rep@example.test", role: "sales" }) },
};
type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const moduleLoader = Module as unknown as { _load: Loader };
const realLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/financeEmail.ts")) {
    if (request === "./db") return { prisma: fakeDb };
    if (request === "./ciExact") return { ciExactIds: async () => ["wesbank"] };
    if (request === "./tenantActor") return { resolveTenantActor: async () => ({ id: "actor" }) };
    if (request === "./push") return { sendPushToAll: async (payload: unknown, kind: unknown, options: unknown) => { pushes.push({ payload, kind, options }); return 1; } };
    if (request === "./permissions") return { canAccessLead: async () => world.mayOpen };
    if (request === "./modules/enabled") return { isModuleEnabled: async (id: string) => id === "finance" && world.financeOn };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { fileFinanceHouseEmail } = createRequire(import.meta.url)("../src/lib/financeEmail.ts") as typeof import("../src/lib/financeEmail");

/*
 * An email from a finance house is filed on the ONE financed deal it names (Sean, 2026-11-16) — by its application
 * reference, else the customer's full name — never guessed between two, and never stored with its attachments.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const deals = [
  { id: "f1", reference: "APP-77", customer: "Jody Van Heerden" },
  { id: "f2", reference: "APP-778", customer: "Grant Smith" },
  { id: "f3", reference: null, customer: "Derek Lallyett" },
];
const match = (text: string, list = deals) => matchFinanceEmail(text, list)?.id ?? null;

test("by reference first — a whole word, any case — then by the customer's full name", () => {
  assert.equal(match("Re: application app-77 approved"), "f1");
  assert.equal(match("APP-778: documents outstanding"), "f2", "APP-77 is not found inside APP-778");
  assert.equal(match("Approval for DEREK  LALLYETT attached"), "f3", "the full name, spacing and case aside");
  assert.equal(match("Status update: Grant Smith (our ref APP-778)"), "f2", "the reference and the name agree");
});

test("a reference that points at one deal while the email names ANOTHER financed customer files nothing (review of #1138)", () => {
  assert.equal(match("Status update: Jody Van Heerden (our ref APP-778)"), null, "APP-778 is Grant's; the email is about Jody");
  // One finance house, two deals: still a conflict, whichever way round.
  assert.equal(match("Grant Smith — see application APP-77"), null);
});

test("what is kept of the body: the answer, with ID, account and contact numbers masked, and shortened", () => {
  const kept = storedFinanceEmailBody("Approved subject to 10% deposit. ID 8001015009087, account 62 1234 5678, call 082 555 0101 or jody@example.com.\n" + "x".repeat(3000));
  assert.match(kept, /^Approved subject to 10% deposit\./);
  assert.doesNotMatch(kept, /8001015009087|62 1234 5678|082 555 0101|jody@example\.com/);
  assert.ok(kept.length < KEPT_BODY_CHARS + 200, String(kept.length));
  assert.match(kept, /The full email is in the mailbox\.\)$/);
});

test("the notification goes to the deal's own salesperson only, and only if they may open it", async () => {
  const filed = async (ownerId: string | null, mayOpen: boolean) => {
    pushes.length = 0;
    world.owner = ownerId;
    world.mayOpen = mayOpen;
    world.dedupe += 1;
    const out = await fileFinanceHouseEmail("deals@wesbank.example", { subject: "APP-77 approved", body: "Approved.", when: new Date(), messageId: null, dedupeKey: `k${world.dedupe}` });
    return { out, pushes: [...pushes] };
  };
  const mine = await filed("rep_1", true);
  assert.equal(mine.out, true);
  assert.deepEqual(mine.pushes.map((p) => p.options), [{ userId: "rep_1" }], "one person, never the whole workspace");
  assert.equal((await filed("rep_1", false)).pushes.length, 0, "a salesperson who can't open the deal: nobody");
  assert.equal((await filed(null, true)).pushes.length, 0, "no salesperson: nobody — it is on the deal");
  assert.equal(stored.at(-1)?.type, "note");
  assert.match(String(stored.at(-1)?.body), /The full email is in the mailbox/);
});

test("Finance module off: not a finance email — nothing filed as one, it goes the ordinary way", async () => {
  world.financeOn = false;
  world.dedupe += 1;
  const before = stored.length;
  try {
    assert.equal(await fileFinanceHouseEmail("deals@wesbank.example", { subject: "APP-77 approved", body: "Approved.", when: new Date(), messageId: null, dedupeKey: `k${world.dedupe}` }), null);
    assert.equal(stored.length, before);
  } finally {
    world.financeOn = true;
  }
});

test("the SUBJECT as stored is masked too (re-review of #1138) — matched on the raw text first, kept masked", async () => {
  world.owner = null;
  world.dedupe += 1;
  const subject = "APP-77 approved — ID 8001015009087, acc 62 1234 5678, call 082 555 0101";
  const out = await fileFinanceHouseEmail("deals@wesbank.example", { subject, body: "Approved.", when: new Date(), messageId: null, dedupeKey: `k${world.dedupe}` });
  assert.equal(out, true, "still matched to the deal by its reference");
  const kept = String(stored.at(-1)?.subject);
  assert.match(kept, /^Email from WesBank: APP-77 approved/);
  assert.doesNotMatch(kept, /8001015009087|62 1234 5678|082 555 0101/);
  assert.equal(storedFinanceEmailSubject("WesBank", "x".repeat(500)).length, 300);
});

test("never a guess: no deal, two deals, or a first name alone files nothing", () => {
  assert.equal(match("Monthly rate update"), null);
  assert.equal(match("APP-77 and APP-778 both approved"), null, "two references");
  assert.equal(match("Jody Van Heerden and Grant Smith — approved"), null, "two names");
  assert.equal(match("Jody's application", [{ id: "x", reference: null, customer: "Jody" }]), null, "a one-word name is too loose");
  assert.equal(match("ref AP", [{ id: "x", reference: "AP", customer: "A B" }]), null, "a reference too short to trust");
});

test("filed as a note on the deal, before ordinary customer routing, with nothing stored but the text", () => {
  const sync = read("src/lib/imapSync.ts");
  const route = sync.slice(sync.indexOf("export async function handleParsedMessage"));
  assert.ok(route.indexOf("fileFinanceHouseEmail(") > 0 && route.indexOf("fileFinanceHouseEmail(") < route.indexOf("return fileTimelineEmail("));
  assert.match(route, /if \(finance !== null\) return finance;/, "a finance house's email never falls through to the customer routing");
  const file = read("src/lib/financeEmail.ts");
  assert.match(file, /ciExactIds\("vendorEmail", fromEmail\)/, "the supplier whose address it IS — exact, never a pattern");
  assert.match(file, /deletedAt: null, kind: "finance"/);
  assert.match(file, /type: "note",\s*direction: null,/, "not the customer writing: no 'waiting on our reply', no contact");
  const code = file.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(code, /attachment|saveFile|document\.create/i, "attachments stay in the mailbox");
  assert.match(file, /dedupeKey: email\.dedupeKey/, "idempotent on the same key as every other filed email");
  assert.match(read("src/lib/automationRegister.ts"), /An email from a finance house \(a supplier of type Finance\) is filed on the one financed deal it names/);
});
