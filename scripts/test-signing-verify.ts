/**
 * "IS THIS THE DOCUMENT THAT WAS SIGNED?" — answered from real rows, for two
 * workspaces at once.
 *
 * The public verify page has no session and no token: the only thing it is
 * given is a file's fingerprint, and from that it has to find the right
 * workspace, in a database where every table is walled off per workspace. What
 * cannot be read off the source is whether that lookup lands in the RIGHT
 * workspace, names the right company, and stays honest when the two records it
 * relies on stop agreeing — so it is run.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. It works in
 * two workspaces of its own. Signing evidence is append-only, so its rows stay
 * behind in the disposable database; every id is unique to the run.
 */
import crypto from "crypto";
import { basePrisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { newSignCapability } from "../src/lib/signing/tokenVault";
import { verifySealedDocument } from "../src/lib/signing/verifyDocument";
import { resolveSealedDocument } from "../src/lib/tokenTenant";

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

const fingerprint = (label: string) => crypto.createHash("sha256").update(`${label}-${SFX}`).digest("hex");

async function main() {
  guardEnvironment();
  // The mode production runs in. The lookup has to find its workspace with no
  // scope to start from, and then read only inside it.
  __setTenantEnforcingForTests(true);

  const staff = await basePrisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!staff) throw new Error("the seeded admin is missing — run the seed first");

  /** A workspace with its own trading name, and one completed signing request sealed with `hash`. */
  async function workspace(label: string, tradingName: string) {
    const tenantId = `tenant_verify_${label}_${SFX}`;
    await basePrisma.tenant.create({ data: { id: tenantId, name: tradingName, slug: tenantId, brandDisplayName: tradingName } });
    return tenantId;
  }
  async function sealed(tenantId: string, hash: string, opts: { title: string; signers: Array<{ role?: string; status: string }> }) {
    const request = await basePrisma.signatureRequest.create({
      data: { title: opts.title, tenantId, status: "in_progress", identityMode: "link", ordering: "parallel", sentAt: new Date(), createdById: staff!.id },
    });
    for (const [index, signer] of opts.signers.entries()) {
      const capability = newSignCapability();
      await basePrisma.signatureRecipient.create({
        data: {
          requestId: request.id, tenantId, name: `Signer ${index + 1}`, role: signer.role ?? "signer", order: index, status: signer.status,
          signedAt: signer.status === "signed" ? new Date() : null, token: capability.digest, tokenCiphertext: capability.ciphertext,
        },
      });
    }
    // Completing is what files the custody record (a database trigger), exactly as it does for a real signature.
    await basePrisma.signatureRequest.update({
      where: { id: request.id },
      data: { status: "completed", completedAt: new Date("2026-10-10T12:30:00Z"), signedPdfRef: `verify-${hash.slice(0, 12)}.pdf`, signedPdfHash: hash },
    });
    return request.id;
  }

  const alpha = await workspace("a", `Alpha Motors ${SFX}`);
  const beta = await workspace("b", `Beta Cycles ${SFX}`);
  const alphaHash = fingerprint("alpha");
  const betaHash = fingerprint("beta");
  const alphaRequest = await sealed(alpha, alphaHash, { title: "Quote Q-9001", signers: [{ status: "signed" }, { status: "signed" }, { status: "sent", role: "viewer" }] });
  await sealed(beta, betaHash, { title: "Sales agreement SA-7", signers: [{ status: "signed" }] });

  console.log("\n== the right workspace answers");
  const a = await verifySealedDocument(alphaHash);
  check("a document sealed by one workspace is genuine, and names that workspace", a.genuine === true && a.sealedBy === `Alpha Motors ${SFX}` && a.title === "Quote Q-9001", JSON.stringify(a));
  const b = await verifySealedDocument(betaHash);
  check("a document sealed by another names the other — never the first", b.genuine === true && b.sealedBy === `Beta Cycles ${SFX}` && b.title === "Sales agreement SA-7", JSON.stringify(b));
  check("only people who signed are counted — not viewers", a.genuine === true && a.signers === 2 && b.genuine === true && b.signers === 1);
  check("the time is given in the workspace's own zone, and says which", a.genuine === true && a.timeZone === "Africa/Johannesburg" && /10 Oct 2026/.test(a.sealedAt) && /14:30/.test(a.sealedAt), a.genuine ? `${a.sealedAt} ${a.timeZone}` : "");
  check("no time-stamp is claimed where none was obtained", a.genuine === true && a.timestamped === false);
  check("the answer carries the verdict and nothing else", Object.keys(a).sort().join() === "genuine,sealedAt,sealedBy,signers,timeZone,timestamped,title");
  check("the fingerprint may arrive in capitals or with spaces round it", (await verifySealedDocument(` ${alphaHash.toUpperCase()} `)).genuine === true);

  console.log("\n== everything else is 'no match', and only that");
  const nothing = JSON.stringify({ genuine: false });
  check("a fingerprint nobody sealed", JSON.stringify(await verifySealedDocument(fingerprint("nobody"))) === nothing);
  check("something that is not a fingerprint never reaches the database", (await resolveSealedDocument("not-a-hash")) === null && (await resolveSealedDocument(`${alphaHash}00`)) === null && JSON.stringify(await verifySealedDocument("' OR 1=1 --")) === nothing);
  check("a request id is not a fingerprint", JSON.stringify(await verifySealedDocument(alphaRequest)) === nothing);

  console.log("\n== the two records must agree");
  const forged = await basePrisma.signatureRequest.create({
    data: { title: "Forged", tenantId: alpha, status: "in_progress", identityMode: "link", ordering: "parallel", sentAt: new Date(), createdById: staff.id },
  });
  const forgedHash = fingerprint("forged");
  await basePrisma.signatureRequest.update({ where: { id: forged.id }, data: { status: "completed", completedAt: new Date(), signedPdfRef: `verify-forged-${SFX}.pdf`, signedPdfHash: forgedHash } });
  check("(a completed request verifies…)", (await verifySealedDocument(forgedHash)).genuine === true);
  // The custody row cannot be changed; the request row can. If it stops naming this file, the file is not vouched for.
  await basePrisma.$executeRaw`UPDATE "SignatureRequest" SET "signedPdfHash" = ${fingerprint("something-else")} WHERE "id" = ${forged.id} AND "tenantId" = ${alpha}`;
  check("…until the request no longer names that file", JSON.stringify(await verifySealedDocument(forgedHash)) === nothing);

  console.log("\n== tidying up does not un-sign a document");
  await basePrisma.$executeRaw`UPDATE "SignatureRequest" SET "deletedAt" = NOW() WHERE "id" = ${alphaRequest} AND "tenantId" = ${alpha}`;
  const trashed = await verifySealedDocument(alphaHash);
  check("a document whose request is in the Trash is still genuine", trashed.genuine === true && trashed.sealedBy === `Alpha Motors ${SFX}`);

  console.log("\n== a time-stamp is only claimed when it verifies");
  await basePrisma.$executeRaw`UPDATE "SignatureRequest" SET "timestampToken" = ${Buffer.from("not a token").toString("base64")} WHERE "id" = ${alphaRequest} AND "tenantId" = ${alpha}`;
  const unverifiable = await verifySealedDocument(alphaHash);
  check("a stored token that does not verify is not called a time-stamp", unverifiable.genuine === true && unverifiable.timestamped === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  await basePrisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await basePrisma.$disconnect().catch(() => {});
  process.exit(1);
});
