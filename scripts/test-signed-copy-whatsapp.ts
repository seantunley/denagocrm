/**
 * A SIGNER WITH NO EMAIL ADDRESS STILL GETS WHAT THEY SIGNED.
 *
 * The completion fan-out skipped anyone without an address — `continue; //
 * nothing to send to` — so a customer reached only by WhatsApp signed a contract
 * and was sent nothing. It now tries the number on file, as a WhatsApp document.
 *
 * What only a real database and the real senders can show:
 *
 *   - the PDF goes to the right number, once, with the workspace's own wording,
 *     and lands on that customer's timeline;
 *   - WhatsApp declining it (the ordinary case: outside the 24-hour window) is
 *     NOT a failed fan-out — or the completion marker would be withheld and the
 *     whole thing re-driven every half hour for a message that cannot arrive —
 *     and is still visible to staff;
 *   - nobody is sent it twice, nobody with an email address is sent it here, and
 *     a workspace with no WhatsApp account sends nothing.
 *
 * WhatsApp itself is replaced by a stand-in `fetch`: every request the code
 * would make to Meta is captured and answered here. Nothing leaves the machine.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Its rows are
 * left in a workspace of their own: a refused send is written to the audit
 * trail, which nothing may delete.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { putTenantCredentialBundle } from "../src/lib/settings";
import { deliverCompletionEmails, type FanoutRecipient } from "../src/lib/signing/completionFanout";
import { exactTenantWhere } from "../src/lib/signing/recoveryScope";
import { hashSignToken, newSignToken } from "../src/lib/signing/tokens";

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

// ── WhatsApp, replaced ──────────────────────────────────────────────────────

type Call = { url: string; kind: "media" | "message" | "other"; body: Record<string, unknown> | null; fileName: string | null };
const calls: Call[] = [];
/** What the next /messages call is answered with. */
let messageReply: { status: number; json: unknown } = { status: 200, json: { messages: [{ id: "wamid.TEST" }] } };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://graph.facebook.com/")) {
    // Anything else is a bug in this test's assumptions, not something to send.
    throw new Error(`unexpected outbound request to ${new URL(url).host}`);
  }
  if (url.endsWith("/media")) {
    const file = init?.body instanceof FormData ? init.body.get("file") : null;
    calls.push({ url, kind: "media", body: null, fileName: file instanceof File ? file.name : null });
    return new Response(JSON.stringify({ id: `media_${calls.length}` }), { status: 200 });
  }
  if (url.endsWith("/messages")) {
    calls.push({ url, kind: "message", body: JSON.parse(String(init?.body ?? "null")), fileName: null });
    return new Response(JSON.stringify(messageReply.json), { status: messageReply.status });
  }
  calls.push({ url, kind: "other", body: null, fileName: null });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

// ── Fixture ─────────────────────────────────────────────────────────────────

const PDF = Buffer.from(`%PDF-1.4\n% signed copy probe ${SFX}\n`, "utf8");

async function workspace(label: string, withWhatsApp: boolean) {
  const tenantId = `wacopy_${label}_${SFX}`;
  const userId = `wacopy_u_${label}_${SFX}`;
  await basePrisma.tenant.create({ data: { id: tenantId, name: `Copy Co ${label}`, slug: tenantId, active: true } });
  await basePrisma.user.create({
    data: { id: userId, name: `Sender ${label}`, email: `${userId}@example.test`, passwordHash: "x", role: "sales", tenantId },
  });
  await basePrisma.tenantMember.create({ data: { tenantId, userId } });
  if (withWhatsApp) {
    await putTenantCredentialBundle(tenantId, { WA_PHONE_NUMBER_ID: `pn_${label}_${SFX}`, WA_ACCESS_TOKEN: `token-${label}-${SFX}` });
  }
  return { tenantId, userId };
}

/** One completed request about one customer, and its recipients. */
async function request(ws: { tenantId: string; userId: string }, title: string, people: Array<{ name: string; email?: string; phone?: string; sentAt?: Date }>) {
  const contact = await basePrisma.contact.create({ data: { firstName: `Customer ${title}`, createdById: ws.userId, tenantId: ws.tenantId } });
  const req = await basePrisma.signatureRequest.create({
    data: { tenantId: ws.tenantId, title, status: "completed", completedAt: new Date(), contactId: contact.id, createdById: ws.userId },
  });
  const recipients: FanoutRecipient[] = [];
  for (const person of people) {
    const row = await basePrisma.signatureRecipient.create({
      data: {
        tenantId: ws.tenantId, requestId: req.id, name: person.name, email: person.email ?? null, phone: person.phone ?? null,
        status: "signed", signedAt: new Date(), token: hashSignToken(newSignToken()), completedEmailSentAt: person.sentAt ?? null,
      },
    });
    recipients.push({ id: row.id, name: row.name, email: row.email, completedEmailSentAt: row.completedEmailSentAt });
  }
  return { id: req.id, title, contactId: contact.id, recipients };
}

const deliver = (ws: { tenantId: string }, req: { id: string; title: string; recipients: FanoutRecipient[] }, tenantId = ws.tenantId) =>
  runInTenantScope({ tenantId: ws.tenantId, system: false }, () =>
    deliverCompletionEmails({ requestId: req.id, title: req.title, pdf: PDF, recipients: req.recipients, tenantWhere: exactTenantWhere(tenantId) }),
  );

const sentAt = async (recipientId: string) =>
  (await basePrisma.signatureRecipient.findUniqueOrThrow({ where: { id: recipientId }, select: { completedEmailSentAt: true } })).completedEmailSentAt;

// ── The test ────────────────────────────────────────────────────────────────

async function main() {
  guardEnvironment();
  const ws = await workspace("a", true);

  console.log("\nA signer with a mobile number and no email address");
  const first = await request(ws, `Quote Q-9001 ${SFX}`, [
    { name: "Ada Mobile", phone: "082 555 0101" },
    { name: "Ben Nothing" },
    { name: "Cy Already", phone: "082 555 0103", sentAt: new Date(Date.now() - 60_000) },
  ]);
  const [ada, ben, cy] = first.recipients;
  calls.length = 0;
  const delivered = await deliver(ws, first);
  const uploads = calls.filter((c) => c.kind === "media");
  const messages = calls.filter((c) => c.kind === "message");
  const doc = messages[0]?.body as { to?: string; type?: string; document?: { id?: string; filename?: string; caption?: string } } | undefined;

  check("the fan-out reports one copy sent and nothing failed", delivered.ok && delivered.sent === 1 && delivered.failures.length === 0, JSON.stringify(delivered));
  check("the PDF is uploaded to WhatsApp once, under the document's name", uploads.length === 1 && uploads[0].fileName === `${first.title}.pdf`, JSON.stringify(uploads.map((u) => u.fileName)));
  check("…through this workspace's own WhatsApp number", uploads.every((u) => u.url.includes(`/pn_a_${SFX}/`)) && messages.every((m) => m.url.includes(`/pn_a_${SFX}/`)));
  check(
    "one document message goes to the signer's number, by uploaded id — never a link",
    messages.length === 1 && doc?.to === "27825550101" && doc?.type === "document" && doc?.document?.id === "media_1" && !JSON.stringify(doc).includes("http"),
    JSON.stringify(doc),
  );
  check(
    "it carries the signed-copy wording, naming the signer and the document",
    Boolean(doc?.document?.caption?.includes("Ada Mobile") && doc.document.caption.includes(first.title) && /signed by all parties/.test(doc.document.caption)),
    doc?.document?.caption ?? "",
  );
  check("that signer is recorded as having their copy", (await sentAt(ada.id)) !== null);
  check("someone with neither an address nor a number is left alone, and is not a failure", (await sentAt(ben.id)) === null);
  check("someone who already has it is not sent it again", !JSON.stringify(calls).includes("27825550103") && (await sentAt(cy.id)) !== null);

  const timeline = await basePrisma.communication.findMany({ where: { contactId: first.contactId }, select: { type: true, direction: true, body: true, messageId: true } });
  check(
    "the send is on the customer's timeline, with the file named",
    timeline.length === 1 && timeline[0].type === "whatsapp" && timeline[0].direction === "outbound" && timeline[0].messageId === "wamid.TEST" &&
      timeline[0].body.includes("[Signed document copy]") && timeline[0].body.includes(`${first.title}.pdf`),
    JSON.stringify(timeline),
  );

  console.log("\nRunning it again");
  calls.length = 0;
  const again = await deliver(ws, { ...first, recipients: await fresh(first.recipients) });
  check("a second pass sends nothing more", again.ok && again.sent === 0 && calls.filter((c) => c.kind === "message").length === 0, JSON.stringify(again));

  console.log("\nWhatsApp declines it (outside the 24-hour window)");
  const second = await request(ws, `Quote Q-9002 ${SFX}`, [{ name: "Dee Quiet", phone: "+27 82 555 0104" }]);
  messageReply = { status: 400, json: { error: { message: "(#131047) Re-engagement message: more than 24 hours have passed since the customer last replied", code: 131047 } } };
  calls.length = 0;
  const declined = await deliver(ws, second);
  check("the attempt is made", calls.filter((c) => c.kind === "message").length === 1);
  check("it is NOT a failed fan-out — the request can still be marked complete", declined.ok && declined.sent === 0 && declined.failures.length === 0, JSON.stringify(declined));
  check("the signer is not recorded as having their copy, so Resend can try again", (await sentAt(second.recipients[0].id)) === null);
  const refused = await basePrisma.auditLog.findMany({ where: { contactId: second.contactId }, select: { action: true, summary: true } });
  check(
    "staff can see it was not delivered, and why, on the customer",
    refused.some((row) => row.action === "whatsapp.failed" && /NOT DELIVERED: Signed document copy/.test(row.summary) && /24-hour reply window/.test(row.summary)),
    JSON.stringify(refused),
  );
  check("nothing was written to the timeline as if it had been sent", (await basePrisma.communication.count({ where: { contactId: second.contactId } })) === 0);
  messageReply = { status: 200, json: { messages: [{ id: "wamid.RETRY" }] } };
  calls.length = 0;
  const retried = await deliver(ws, { ...second, recipients: await fresh(second.recipients) });
  check("…and a later try, once they have been in touch, delivers it", retried.sent === 1 && (await sentAt(second.recipients[0].id)) !== null);

  console.log("\nWho is NOT sent it on WhatsApp");
  const third = await request(ws, `Quote Q-9003 ${SFX}`, [{ name: "Eve Email", email: `eve-${SFX}@example.test`, phone: "082 555 0105" }]);
  calls.length = 0;
  await deliver(ws, third);
  check("a signer with an email address is emailed, not messaged", calls.filter((c) => c.kind !== "other").length === 0, JSON.stringify(calls.map((c) => c.kind)));

  const fourth = await request(ws, `Quote Q-9004 ${SFX}`, [{ name: "Fay Elsewhere", phone: "082 555 0106" }]);
  calls.length = 0;
  const wrongOwner = await deliver(ws, fourth, `wacopy_other_${SFX}`);
  check("a recipient outside the named workspace is not looked up, so not messaged", calls.length === 0 && wrongOwner.sent === 0 && (await sentAt(fourth.recipients[0].id)) === null);

  const bare = await workspace("b", false);
  const fifth = await request(bare, `Quote Q-9005 ${SFX}`, [{ name: "Gus Unconnected", phone: "082 555 0107" }]);
  calls.length = 0;
  const unconnected = await deliver(bare, fifth);
  check("a workspace with no WhatsApp account sends nothing, and that is not a failure", calls.length === 0 && unconnected.ok && unconnected.sent === 0, JSON.stringify(unconnected));

  console.log(`\n${passed} passed, ${failed} failed`);
}

/** The recipients as the next caller would load them — with whatever was recorded since. */
async function fresh(recipients: FanoutRecipient[]): Promise<FanoutRecipient[]> {
  const rows = await basePrisma.signatureRecipient.findMany({
    where: { id: { in: recipients.map((r) => r.id) } },
    select: { id: true, name: true, email: true, completedEmailSentAt: true },
  });
  return recipients.map((r) => rows.find((row) => row.id === r.id) ?? r);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(async () => {
    globalThis.fetch = realFetch;
    await basePrisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
