/**
 * Bounced email, end to end on a real database (PR #907): a delivery-failure
 * notice goes through the mailbox sync's own handler, and this checks what lands
 * on the email, on the customer's history, and in the sender's alert.
 *
 *   npm run test:email-bounces      (DATABASE_URL = a disposable, migrated, seeded database)
 *
 * Push is never configured here, so the real sendPushToAll accepts nothing and
 * returns 0 — the case that must leave the alert OWED. A stand-in push that
 * accepts is passed to notifyBounces to prove a later retry then records it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { simpleParser } from "mailparser";

process.env.TENANT_ENFORCEMENT ||= "enforce";
delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const OURS = "crm@example.invalid";
const run = Date.now();
const fixture = readFileSync("tests/fixtures/bounce-exim-dsn.eml", "utf8");

/** The MWEB notice, re-addressed: to `to`, about `messageId` (no copy of the original when omitted). */
function notice(opts: { to: string; messageId?: string; delayed?: boolean; deliveredToo?: string }) {
  let raw = fixture.replaceAll("erikjvr@mweb.co.za", opts.to).replace(/^Date: .*$/m, `Date: ${new Date().toUTCString()}`);
  raw = opts.messageId
    ? raw.replace("<a1b2c3d4-e5f6-7890@denagocpt.co.za>", opts.messageId)
    : raw.replace(/--1760263205-eximdsn-123456\r?\nContent-type: message\/rfc822[\s\S]*?(?=--1760263205-eximdsn-123456--)/, "");
  if (opts.delayed) raw = raw.replace(/^X-Failed-Recipients: .*\r?\n/m, "").replace("Action: failed", "Action: delayed");
  if (opts.deliveredToo) raw = raw.replace("Action: failed", `Action: delivered\nFinal-Recipient: rfc822;${opts.deliveredToo}\nStatus: 2.0.0\n\nAction: failed`);
  return simpleParser(raw);
}

let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { handleParsedMessage, notifyBounces } = await import("../src/lib/imapSync");

  const notes = async (contactId: string) =>
    (await basePrisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM "AuditLog" WHERE action = 'email.bounced' AND "contactId" = $1`, contactId))[0].n;
  const sender = await basePrisma.user.findFirstOrThrow({ where: { tenantId: { not: null } }, select: { id: true, tenantId: true } });
  const tenantId = sender.tenantId!;

  await runInTenantScope({ tenantId, system: false }, async () => {
    const sentEmail = async (tag: string) => {
      const email = `bounce-${tag}-${run}@example.invalid`;
      const contact = await basePrisma.contact.create({ data: { firstName: "Bounce", lastName: tag, email, tenantId } });
      const comm = await basePrisma.communication.create({
        data: {
          type: "email", direction: "outbound", subject: `Quote for ${tag}`, body: "Hi", contactId: contact.id, userId: sender.id, tenantId,
          messageId: `<bounce-${tag}-${run}@example.invalid>`, occurredAt: new Date(Date.now() - 3600_000),
        },
      });
      return { email, contact, comm, mid: comm.messageId! };
    };
    const row = (id: string) => basePrisma.communication.findUniqueOrThrow({ where: { id }, select: { bouncedAt: true, bounceReason: true, bounceNotifiedAt: true } });
    const accepting: typeof import("../src/lib/push").sendPushToAll = async (_payload, _kind, options) => {
      assert.equal(options?.userId, sender.id, "the alert goes to whoever sent the email");
      return 1;
    };

    // 1. Identified by its Message-ID: stamped and noted once; the alert is owed until a push is ACCEPTED.
    const a = await sentEmail("exact");
    assert.equal(await handleParsedMessage(await notice({ to: a.email, messageId: a.mid }), OURS, "bounce:1"), true);
    let ra = await row(a.comm.id);
    assert.equal(ra.bounceReason, `${a.email}: 550 High probability of spam`);
    assert.ok(ra.bouncedAt);
    assert.equal(await notes(a.contact.id), 1);
    ok("an identified email is marked not delivered and noted on the customer's history");
    assert.equal(ra.bounceNotifiedAt, null, "push accepted nothing (0) — not told");
    await notifyBounces(a.comm.id, async () => 0);
    assert.equal((await row(a.comm.id)).bounceNotifiedAt, null);
    ok("a push that reaches nobody (0) leaves the alert owed");
    await notifyBounces(a.comm.id, accepting);
    ra = await row(a.comm.id);
    assert.ok(ra.bounceNotifiedAt);
    ok("a later retry that is accepted records the sender as told");
    assert.equal(await handleParsedMessage(await notice({ to: a.email, messageId: a.mid }), OURS, "bounce:1"), false);
    assert.equal(await notes(a.contact.id), 1);
    assert.equal((await row(a.comm.id)).bounceNotifiedAt?.getTime(), ra.bounceNotifiedAt.getTime());
    ok("the same notice again changes nothing");

    // 2. Mixed report: the To was delivered, the CC failed — only the CC is named.
    const b = await sentEmail("mixed");
    const cc = `cc-${run}@example.invalid`;
    assert.equal(await handleParsedMessage(await notice({ to: cc, messageId: b.mid, deliveredToo: b.email }), OURS, "bounce:2"), true);
    assert.equal((await row(b.comm.id)).bounceReason, `${cc}: 550 High probability of spam`);
    ok("a mixed report names only the recipient that failed");

    // 3. Two notices about different addresses of one email, at the same moment: both kept.
    const c = await sentEmail("concurrent");
    const other = `other-${run}@example.invalid`;
    const both = await Promise.all([
      handleParsedMessage(await notice({ to: c.email, messageId: c.mid }), OURS, "bounce:3a"),
      handleParsedMessage(await notice({ to: other, messageId: c.mid }), OURS, "bounce:3b"),
    ]);
    assert.deepEqual(both, [true, true]);
    assert.deepEqual((await row(c.comm.id)).bounceReason!.split("\n").sort(), [`${c.email}: 550 High probability of spam`, `${other}: 550 High probability of spam`].sort());
    assert.equal(await notes(c.contact.id), 2);
    ok("concurrent notices for one email both land");

    // 4. A second address failing later re-opens the alert for it.
    await notifyBounces(c.comm.id, accepting);
    assert.ok((await row(c.comm.id)).bounceNotifiedAt);
    assert.equal(await handleParsedMessage(await notice({ to: `late-${run}@example.invalid`, messageId: c.mid }), OURS, "bounce:4"), true);
    assert.equal((await row(c.comm.id)).bounceNotifiedAt, null);
    ok("a later failed address makes the alert owed again");

    // 5. The history write fails: the stamp is undone, and the sync's retry files it.
    const d = await sentEmail("audit-fails");
    await basePrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION bounce_test_fail() RETURNS trigger AS $$ BEGIN
      IF NEW.summary LIKE '%audit-fails%' THEN RAISE EXCEPTION 'simulated audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await basePrisma.$executeRawUnsafe(`CREATE TRIGGER bounce_test_fail BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION bounce_test_fail()`);
    try {
      await assert.rejects(async () => handleParsedMessage(await notice({ to: d.email, messageId: d.mid }), OURS, "bounce:5"));
      assert.equal((await row(d.comm.id)).bouncedAt, null);
      assert.equal(await notes(d.contact.id), 0);
    } finally {
      await basePrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS bounce_test_fail ON "AuditEvent"`);
      await basePrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS bounce_test_fail()`);
    }
    assert.equal(await handleParsedMessage(await notice({ to: d.email, messageId: d.mid }), OURS, "bounce:5"), true);
    assert.ok((await row(d.comm.id)).bouncedAt);
    assert.equal(await notes(d.contact.id), 1);
    ok("a failed history note rolls the stamp back; the retry files both");

    // 6. The sweep (no id) delivers every owed alert.
    await notifyBounces(undefined, accepting);
    for (const id of [b.comm.id, c.comm.id, d.comm.id]) assert.ok((await row(id)).bounceNotifiedAt);
    ok("the sync's sweep sends every alert still owed");

    // 7. Not identified: a customer note only. A delay, or an address nobody has: nothing.
    const e = await sentEmail("no-copy");
    assert.equal(await handleParsedMessage(await notice({ to: e.email }), OURS, "bounce:7"), true);
    assert.equal((await row(e.comm.id)).bouncedAt, null);
    assert.equal(await notes(e.contact.id), 1);
    ok("an unidentified notice is noted on the customer, and marks no email");
    const f = await sentEmail("delayed");
    assert.equal(await handleParsedMessage(await notice({ to: f.email, messageId: f.mid, delayed: true }), OURS, "bounce:8"), false);
    assert.equal((await row(f.comm.id)).bouncedAt, null);
    assert.equal(await handleParsedMessage(await notice({ to: `stranger-${run}@example.invalid` }), OURS, "bounce:9"), false);
    ok("a delay warning, or an address the CRM doesn't know, changes nothing");
  });

  console.log(`\nemail bounces: ${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((error) => {
  console.error("\nemail bounces FAILED:", error);
  process.exit(1);
});
