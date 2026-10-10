/**
 * IN-PERSON SIGNING ACTUALLY SUBMITS.
 *
 * From 2026-08-06 to 2026-10-09 the in-person screen could not sign anything.
 * Signing links had become digests at rest, the screen still handed the stored
 * value to the signing form, and the route hashed it a second time and found
 * nothing — "Not found", after the customer had filled the whole document in.
 * Every structural test passed throughout, because each half was correct on its
 * own: the screen rendered, and the route rejected a link it did not know.
 *
 * So this runs the two halves together against a real database, through the
 * real route handlers: what the screen is given, posted to what the route
 * accepts. It also pins the rule that replaced the emailed code in person — a
 * staff member's pass, for one signer, for a short while — and what a customer's
 * decline now does to the quote.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. The signing
 * evidence it writes is append-only by design (the database refuses to delete
 * it), so its rows stay behind in the disposable database rather than being
 * cleaned up; every id is unique to the run.
 */
import { basePrisma } from "../src/lib/db";
import { newSignCapability, usableCapability, hashSignToken } from "../src/lib/signing/tokenVault";
import { mintInPersonPass, IN_PERSON_PASS_MINUTES } from "../src/lib/signing/inPerson";
import { resolveSignRecipientTenant, resolveSignRecipientTenantForNotice } from "../src/lib/tokenTenant";
import { POST as signRoute } from "../src/app/api/signing/[token]/route";
import { POST as declineRoute } from "../src/app/api/signing/[token]/decline/route";

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

type Signer = { id: string; link: string; digest: string };

const post = (
  route: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>,
  token: string,
  body: unknown,
) =>
  route(
    new Request(`http://localhost/api/signing/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );

async function main() {
  guardEnvironment();
  // Each call below is throttled per link and per caller address, and with no
  // HTTP request every one of them shares the "unknown" address.
  await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit"`;

  const tenant = await basePrisma.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const staff = await basePrisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (!tenant || !staff) throw new Error("the seeded workspace and admin are missing — run the seed first");
  const tenantId = tenant.id;

  // A quote out for signature with a one-time code required: the case where the
  // in-person screen had nowhere to enter one.
  const quote = await basePrisma.quote.create({
    data: { number: 900_000_000 + Math.floor(Math.random() * 99_999_999), status: "sent", tenantId, createdById: staff.id },
  });
  const request = await basePrisma.signatureRequest.create({
    data: { title: `In-person test ${SFX}`, tenantId, status: "sent", identityMode: "otp", ordering: "parallel", quoteId: quote.id, sentAt: new Date(), createdById: staff.id },
  });
  const signers: Signer[] = [];
  for (const [index, name] of ["First Signer", "Second Signer"].entries()) {
    const capability = newSignCapability();
    const row = await basePrisma.signatureRecipient.create({
      data: {
        requestId: request.id, tenantId, name, email: `inperson-${index}-${SFX}@example.test`, role: "signer", order: index,
        status: "sent", token: capability.digest, tokenCiphertext: capability.ciphertext,
      },
    });
    signers.push({ id: row.id, link: capability.raw, digest: capability.digest });
  }
  const [first, second] = signers;
  const witness = { userId: staff.id, name: staff.name };
  const submission = { name: "First Signer", consent: true, consentVersion: "za-ecta-v1", fields: [] };

  console.log("\n== what the in-person screen is given");
  const handedOver = await usableCapability("signatureRecipient", first.id, (await basePrisma.signatureRecipient.findUnique({ where: { id: first.id }, select: { tokenCiphertext: true } }))?.tokenCiphertext, first.digest);
  check("the screen's link is the delivered one, not the stored digest", handedOver === first.link && handedOver !== first.digest);
  check("and it resolves to the signer's own row", hashSignToken(handedOver ?? "") === first.digest);

  console.log("\n== the old behaviour: the stored digest, posted back");
  const withDigest = await post(signRoute, first.digest, { ...submission, inPerson: mintInPersonPass(first.id, tenantId, witness) });
  check("is not found — exactly the failure customers met", withDigest.status === 404, `HTTP ${withDigest.status}`);

  console.log("\n== a code is still required without a witness");
  const noPass = await post(signRoute, first.link, submission);
  check("the link alone cannot sign a document that asks for a code", noPass.status === 403, `HTTP ${noPass.status} ${await noPass.text()}`);

  console.log("\n== a pass is for one signer, for a while");
  const someoneElses = await post(signRoute, first.link, { ...submission, inPerson: mintInPersonPass(second.id, tenantId, witness) });
  check("a pass minted for another signer is refused", someoneElses.status === 403, `HTTP ${someoneElses.status}`);
  const lapsed = await post(signRoute, first.link, { ...submission, inPerson: mintInPersonPass(first.id, tenantId, witness, Date.now() - (IN_PERSON_PASS_MINUTES + 1) * 60_000) });
  check("an expired pass is refused", lapsed.status === 403, `HTTP ${lapsed.status}`);
  const otherWorkspace = await post(signRoute, first.link, { ...submission, inPerson: mintInPersonPass(first.id, `${tenantId}_other`, witness) });
  check("a pass minted in another workspace is refused", otherWorkspace.status === 403, `HTTP ${otherWorkspace.status}`);
  const untouched = await basePrisma.signatureRecipient.findUnique({ where: { id: first.id }, select: { status: true, identityVerifiedAt: true } });
  check("none of those signed or verified anything", untouched?.status === "sent" && untouched.identityVerifiedAt === null, JSON.stringify(untouched));

  console.log("\n== signing in person");
  const signed = await post(signRoute, first.link, { ...submission, inPerson: mintInPersonPass(first.id, tenantId, witness) });
  check("the signature is accepted", signed.status === 200, `HTTP ${signed.status} ${signed.status === 200 ? "" : await signed.text()}`);
  const signedRow = await basePrisma.signatureRecipient.findUnique({ where: { id: first.id } });
  check("the signer is signed, and their identity is recorded as witnessed in person", signedRow?.status === "signed" && signedRow.identityMethod === "in_person" && signedRow.identityVerifiedAt !== null && Boolean(signedRow.identityEvidenceHash), `${signedRow?.status} / ${signedRow?.identityMethod}`);
  const signedEvent = await basePrisma.signatureEvent.findFirst({ where: { requestId: request.id, recipientId: first.id, type: "signed" } });
  const metadata = (signedEvent?.metadata ?? {}) as { witness?: { userId?: string; name?: string }; consent?: { version?: string; text?: string } };
  check("the evidence names the witness", signedEvent?.channel === "in_person" && metadata.witness?.userId === staff.id && metadata.witness?.name === staff.name, JSON.stringify(metadata.witness ?? null));
  check("the evidence records the words that were agreed to", metadata.consent?.version === "za-ecta-v1" && /Electronic Communications and Transactions Act/.test(metadata.consent?.text ?? ""), JSON.stringify(metadata.consent ?? null).slice(0, 80));
  const twice = await post(signRoute, first.link, { ...submission, inPerson: mintInPersonPass(first.id, tenantId, witness) });
  check("it cannot be signed twice", twice.status === 409, `HTTP ${twice.status}`);

  console.log("\n== declining in person, and what it does to the quote");
  const unwitnessed = await post(declineRoute, second.link, { reason: "Too expensive" });
  check("declining also needs the code or a witness", unwitnessed.status === 403, `HTTP ${unwitnessed.status}`);
  const declined = await post(declineRoute, second.link, { reason: "Too expensive", inPerson: mintInPersonPass(second.id, tenantId, witness) });
  check("the decline is accepted", declined.status === 200, `HTTP ${declined.status} ${declined.status === 200 ? "" : await declined.text()}`);
  const closed = await basePrisma.signatureRequest.findUnique({ where: { id: request.id }, select: { status: true } });
  check("the request is declined", closed?.status === "declined", closed?.status);
  const declinedQuote = await basePrisma.quote.findUnique({ where: { id: quote.id }, select: { status: true, declineReason: true, declinedAt: true } });
  check("the QUOTE is marked declined, with the customer's reason", declinedQuote?.status === "declined" && declinedQuote.declineReason === "Too expensive" && declinedQuote.declinedAt !== null, JSON.stringify(declinedQuote));
  const declineEvent = await basePrisma.signatureEvent.findFirst({ where: { requestId: request.id, recipientId: second.id, type: "declined" } });
  check("the decline is recorded as witnessed", declineEvent?.channel === "in_person" && (declineEvent.metadata as { witness?: { userId?: string } })?.witness?.userId === staff.id);

  console.log("\n== once it is finished");
  // The throttle has by now (correctly) had enough of this caller; it is not what
  // is being asked about here.
  await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit"`;
  const afterwards = await post(signRoute, first.link, submission);
  check("the link can no longer act", afterwards.status === 404, `HTTP ${afterwards.status}`);
  check("the acting resolver refuses a finished link", (await resolveSignRecipientTenant(first.link)) === null);
  check("but the customer can still be told what happened to it", (await resolveSignRecipientTenantForNotice(first.link))?.tenantId === tenantId);
  check("a link that never existed resolves to nothing, either way", (await resolveSignRecipientTenantForNotice("0".repeat(56))) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
