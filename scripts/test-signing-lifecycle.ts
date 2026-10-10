/**
 * HOW A SIGNING REQUEST ENDS WITHOUT A SIGNATURE — expiry and void, against a
 * real database.
 *
 * Both are one conditional UPDATE away from doing the wrong thing, and neither
 * can be seen from the source: whether the status trigger really revokes the
 * links, whether a request everyone has signed is left alone, whether a void
 * takes the quote back with it and a second void takes nothing. Those are
 * properties of the statements running against the triggers, so they are run.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Signing
 * evidence is append-only (the database refuses to delete it), so the rows stay
 * behind in the disposable database; every id is unique to the run.
 */
import { basePrisma } from "../src/lib/db";
import { newSignCapability } from "../src/lib/signing/tokenVault";
import { expireOverdueSigningRequests, quoteLinkExpiry } from "../src/lib/signing/expiry";
import { voidOpenRequest } from "../src/lib/signing/void";
import { quoteExpired } from "../src/lib/quoteExpiry";

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

const HOUR = 3_600_000;

async function main() {
  guardEnvironment();
  const tenant = await basePrisma.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const staff = await basePrisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!tenant || !staff) throw new Error("the seeded workspace and admin are missing — run the seed first");
  const tenantId = tenant.id;
  let quoteNumber = 800_000_000 + Math.floor(Math.random() * 90_000_000);

  /** A quote out for signature: one request, its signers, and the quote behind it. */
  async function outForSignature(opts: { expiresAt: Date | null; signers: string[]; quoteStatus?: string; requestStatus?: string; quoteSigned?: boolean }) {
    const quote = await basePrisma.quote.create({
      data: { number: quoteNumber++, status: opts.quoteStatus ?? "sent", tenantId, createdById: staff!.id, signedAt: opts.quoteSigned ? new Date() : null },
    });
    const request = await basePrisma.signatureRequest.create({
      data: {
        title: `Lifecycle test ${SFX}`, tenantId, status: opts.requestStatus ?? "sent", identityMode: "link", ordering: "parallel",
        quoteId: quote.id, sentAt: new Date(), expiresAt: opts.expiresAt, createdById: staff!.id,
      },
    });
    for (const [index, status] of opts.signers.entries()) {
      const capability = newSignCapability();
      await basePrisma.signatureRecipient.create({
        data: {
          requestId: request.id, tenantId, name: `Signer ${index + 1}`, email: `lifecycle-${index}-${SFX}@example.test`, role: "signer", order: index,
          status, signedAt: status === "signed" ? new Date() : null, token: capability.digest, tokenCiphertext: capability.ciphertext,
        },
      });
    }
    return { quoteId: quote.id, requestId: request.id };
  }
  const requestStatus = async (id: string) => (await basePrisma.signatureRequest.findUnique({ where: { id }, select: { status: true } }))?.status;
  const quoteStatus = async (id: string) => (await basePrisma.quote.findUnique({ where: { id }, select: { status: true } }))?.status;

  console.log("\n== expiry");
  const overdue = await outForSignature({ expiresAt: new Date(Date.now() - HOUR), signers: ["sent"] });
  const everyoneSigned = await outForSignature({ expiresAt: new Date(Date.now() - HOUR), signers: ["signed", "signed"], requestStatus: "in_progress" });
  const partlySigned = await outForSignature({ expiresAt: new Date(Date.now() - HOUR), signers: ["signed", "viewed"], requestStatus: "in_progress" });
  const stillValid = await outForSignature({ expiresAt: new Date(Date.now() + 24 * HOUR), signers: ["sent"] });
  const neverExpires = await outForSignature({ expiresAt: null, signers: ["sent"] });

  check("another workspace's sweep closes nothing of ours", (await expireOverdueSigningRequests(`${tenantId}_other`)) === 0 && (await requestStatus(overdue.requestId)) === "sent");
  const closed = await expireOverdueSigningRequests(tenantId);
  check("the sweep reports what it closed", closed >= 2, `closed ${closed}`);
  check("a request past its expiry is expired", (await requestStatus(overdue.requestId)) === "expired");
  check("one that is only partly signed is expired too", (await requestStatus(partlySigned.requestId)) === "expired");
  check("one EVERYONE has signed is left to complete", (await requestStatus(everyoneSigned.requestId)) === "in_progress");
  check("one still inside its date is untouched", (await requestStatus(stillValid.requestId)) === "sent");
  check("one with no expiry is untouched — a link sent before this rule keeps working", (await requestStatus(neverExpires.requestId)) === "sent");
  const revoked = await basePrisma.signatureRecipient.count({ where: { requestId: overdue.requestId, tokenRevokedAt: { not: null } } });
  check("expiring revokes the signing links", revoked === 1, `revoked ${revoked}`);
  const live = await basePrisma.signatureRecipient.count({ where: { requestId: stillValid.requestId, tokenRevokedAt: null } });
  check("…and only those", live === 1);
  const event = await basePrisma.signatureEvent.findFirst({ where: { requestId: overdue.requestId, type: "expired" }, select: { actor: true } });
  check("the evidence records the expiry", event?.actor === "system");
  check("the quote keeps its own status — its date is what expired", (await quoteStatus(overdue.quoteId)) === "sent");
  check("a second sweep finds nothing left to close", (await expireOverdueSigningRequests(tenantId)) === 0);

  console.log("\n== a link expires exactly when its quote does");
  const apart: string[] = [];
  for (const timeZone of ["Africa/Johannesburg", "America/New_York", "Pacific/Auckland", "Europe/London"]) {
    // The days the clocks change in each of these zones in 2026, and an ordinary one.
    for (const day of ["2026-03-08", "2026-03-29", "2026-04-05", "2026-09-27", "2026-10-06", "2026-10-25", "2026-11-01"]) {
      const validUntil = new Date(`${day}T12:00:00Z`);
      const expiry = quoteLinkExpiry(validUntil, timeZone)!;
      // The last millisecond the quote is still valid, and the first it is not.
      const before = quoteExpired(validUntil, timeZone, new Date(expiry.getTime() - 1));
      const at = quoteExpired(validUntil, timeZone, expiry);
      if (before || !at) apart.push(`${timeZone} ${day} (${expiry.toISOString()})`);
    }
  }
  check("the link's expiry is the instant the quote itself becomes expired, in every zone and across clock changes", apart.length === 0, apart.join("; "));
  check("a quote with no valid-until date gives a link with no expiry", quoteLinkExpiry(null, "Africa/Johannesburg") === null);

  console.log("\n== void");
  const sent = await outForSignature({ expiresAt: null, signers: ["sent"] });
  const voided = await voidOpenRequest(sent.requestId);
  check("voiding reports the record it belonged to", voided?.quoteId === sent.quoteId && voided.tenantId === tenantId);
  check("the request is voided", (await requestStatus(sent.requestId)) === "voided");
  check("the quote goes back to draft", (await quoteStatus(sent.quoteId)) === "draft");
  check("its links are revoked", (await basePrisma.signatureRecipient.count({ where: { requestId: sent.requestId, tokenRevokedAt: null } })) === 0);
  check("a second void does nothing", (await voidOpenRequest(sent.requestId)) === null);

  const accepted = await outForSignature({ expiresAt: null, signers: ["sent"], quoteStatus: "accepted", quoteSigned: true });
  await voidOpenRequest(accepted.requestId);
  check("an accepted quote keeps its status when a stray request is voided", (await quoteStatus(accepted.quoteId)) === "accepted");

  const finished = await outForSignature({ expiresAt: null, signers: ["declined"], requestStatus: "declined", quoteStatus: "declined" });
  check("a closed request cannot be voided over", (await voidOpenRequest(finished.requestId)) === null && (await requestStatus(finished.requestId)) === "declined");
  check("…and its quote is left as it was", (await quoteStatus(finished.quoteId)) === "declined");
  check("a request that does not exist voids nothing", (await voidOpenRequest(`missing_${SFX}`)) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
