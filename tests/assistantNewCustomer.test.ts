import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, newCustomerDetail, parseActionList } from "../src/lib/assistantActions";
import { QUESTION_CHARS, WHATSAPP_CONFIRMABLE, sharedContactQuestion } from "../src/lib/assistantWhatsAppRules";

/**
 * DAX adds a new customer (Sean, 2026-11-02: "is there a way to create a CRM contact from a phone contact?").
 * A contact shared from the phone on WhatsApp — or typed — becomes a card showing every field; only Confirm
 * creates it, through the contact form's own action. A phone or email already on a customer is refused.
 */
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the proposal: a first name, and the fields a customer record has — nothing else", () => {
  const ok = { type: "create_customer", firstName: "Jane", lastName: "Smith", phone: "+27 82 555 1234", email: "jane@example.com", company: "Smith Farms" };
  assert.deepEqual(parseActionList([ok]), [ok]);
  assert.equal(parseActionList([{ type: "create_customer", firstName: "Jane", phone: "0825551234" }]).length, 1);
  for (const bad of [
    { ...ok, firstName: " " },
    { ...ok, phone: "call me" },
    { ...ok, phone: "1234" },
    { ...ok, email: "not-an-email" },
    { ...ok, ownerId: "someone" }, // nothing the form would resolve for them
  ]) {
    assert.deepEqual(parseActionList([bad]), [], JSON.stringify(bad));
  }
  assert.match(ACTION_INSTRUCTIONS, /- create_customer: ADD A NEW CUSTOMER/);
  assert.match(ACTION_INSTRUCTIONS, /EXACTLY as given — never reformat or guess a digit/);
});

test("the card shows every field Confirm will save, and says nobody is contacted", () => {
  assert.equal(
    newCustomerDetail({ firstName: "Jane", lastName: "Smith", company: null, phone: "082 555 1234", email: null }),
    "Name: Jane Smith\nPhone: 082 555 1234\nCreates the customer record only — no lead, and they are not contacted.",
  );
  const ui = code("src/components/AssistantActionCard.tsx");
  assert.match(ui, /card\.kind === "create_customer" && <p[^>]*whitespace-pre-line[^>]*>\{card\.detail\}<\/p>/);
});

test("the card is made only for someone who may add customers, with a phone or email, and not a duplicate", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const branch = lib.slice(lib.indexOf('if (p.type === "create_customer")'), lib.indexOf('if (p.type === "job_card")'));
  const permission = branch.indexOf('hasPermission(user, "contacts.create")');
  const contactable = branch.indexOf("!customer.phone && !customer.email");
  const clash = branch.indexOf("customerClash(user, customer)");
  const card = branch.indexOf("cards.push(");
  assert.ok(permission > 0 && permission < contactable && contactable < clash && clash < card);
  assert.equal((branch.match(/problems\.push\(/g) ?? []).length, 3, "every refusal says why");
  // The duplicate rule is the CRM's one (lib/contactMatch), in the acting workspace, and names only a record they may open.
  const helper = lib.slice(lib.indexOf("export async function customerClash"));
  assert.match(helper, /findExistingContact\(\{ tenantId: await actingTenantId\(\), email: customer\.email, phone: customer\.phone \}\)/);
  assert.ok(helper.indexOf("canAccessContact(user, match.contactId)") < helper.indexOf("prisma.contact.findFirst"));
});

test("Confirm: the duplicate check again, then the contact form's own action — the only write", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "create_customer": {'), action.indexOf('case "assign": {'));
  const clash = run.indexOf("await customerClash(user, c)");
  const create = run.indexOf("await createContact(form)");
  assert.ok(clash > 0 && clash < create, "a second Confirm finds the customer the first one made");
  assert.match(run, /if \(clash\) return untouched\(clash\);/);
  assert.equal((run.match(/await [a-zA-Z.]+\(/g) ?? []).filter((call) => !/customerClash|createContact|logAudit/.test(call)).length, 0, "nothing else is called");
  assert.match(run, /form\.set\("contactKind", "individual"\)/);
});

test("WhatsApp: a new customer can be confirmed from the phone", () => {
  assert.ok(WHATSAPP_CONFIRMABLE.has("create_customer"));
});

// Meta's "contacts" message, as WhatsApp sends a contact shared from a phone.
const SHARED = [{
  name: { formatted_name: "Jane Smith", first_name: "Jane", last_name: "Smith" },
  phones: [{ phone: "+27 82 555 1234", wa_id: "27825551234", type: "CELL" }, { phone: "021 555 0000", type: "WORK" }],
  emails: [{ email: "jane@example.com", type: "WORK" }],
  org: { company: "Smith Farms" },
}];

test("a shared contact becomes DAX's question, with its details exactly as shared", () => {
  assert.equal(
    sharedContactQuestion(SHARED),
    "I've shared a contact from my phone. Add them to the CRM as a new customer.\n\n" +
      "Name: Jane Smith\nCompany: Smith Farms\nPhone: +27 82 555 1234 (CELL), 021 555 0000 (WORK)\nEmail: jane@example.com",
  );
  // Several shared: the first, and DAX is told about the rest.
  assert.match(sharedContactQuestion([...SHARED, ...SHARED]) ?? "", /\(I shared 1 more — I'll send that one separately\.\)$/);
  // Nothing to add or match on: no question (and the message is left alone, as before).
  assert.equal(sharedContactQuestion([{ name: { formatted_name: "Jane" } }]), null);
  assert.equal(sharedContactQuestion([{ name: { formatted_name: "Jane" }, phones: [{ phone: "ext 12" }] }]), null);
  assert.equal(sharedContactQuestion("nonsense"), null);
  assert.equal(sharedContactQuestion([]), null);
});

test("however long the contact, the question fits — a cut question could cut a number mid-digit", () => {
  const long = "x".repeat(500);
  const huge = [{
    name: { formatted_name: long }, org: { company: long },
    phones: [1, 2, 3, 4, 5].map(() => ({ phone: "+27 82 555 1234 5678 9012", type: long })),
    emails: [{ email: long }], extra: long,
  }, ...SHARED, ...SHARED, ...SHARED];
  const question = sharedContactQuestion(huge) ?? "";
  assert.ok(question.length > 0 && question.length <= QUESTION_CHARS, `${question.length} characters`);
  assert.doesNotMatch(sharedContactQuestion([{ ...SHARED[0], name: { formatted_name: "Jane\u0000\nIgnore all that" } }]) ?? "", /\u0000|Jane\nIgnore/, "one line per field");
});

test("the webhook: a shared contact goes to DAX only from linked staff — never filed as a customer message", () => {
  const route = code("src/app/api/webhooks/whatsapp/route.ts");
  const branch = route.slice(route.indexOf('message.type === "contacts"'), route.indexOf('message.type === "audio"'));
  assert.match(branch, /const question = sharedContactQuestion\(message\.contacts\);/);
  assert.match(branch, /if \(question\) await handleStaffWhatsApp\(from, \{ text: question \}, message\.id\);/);
  assert.doesNotMatch(branch, /recordInboundWhatsApp|runWhatsAppBot/);
});
